import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { execFileSync, execSync, spawn as nodeSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  killProcessOnPort,
  waitForServerReady,
  getBunExecutable,
  getPlatformOptions,
} from './test-utils';
import { TEST_TIMEOUTS } from '../test-timeouts';

describe('ElizaOS Agent Commands', () => {
  let serverProcess: any;
  let testTmpDir: string;
  let testServerPort: string;
  let testServerUrl: string;
  let elizaosCmd: string;

  beforeAll(async () => {
    // Setup test environment
    testServerPort = '3000';
    testServerUrl = `http://localhost:${testServerPort}`;
    testTmpDir = await mkdtemp(join(tmpdir(), 'eliza-test-agent-'));

    // Setup CLI command with robust bun path detection
    const scriptDir = join(__dirname, '..');
    const detectedBunPath = getBunExecutable();
    elizaosCmd = `${detectedBunPath} ${join(scriptDir, '../dist/index.js')}`;
    console.log(`[DEBUG] Using bun path: ${detectedBunPath}`);
    console.log(`[DEBUG] ElizaOS command: ${elizaosCmd}`);

    // Kill any existing processes on port 3000 with extended cleanup for macOS CI
    console.log('[DEBUG] Cleaning up any existing processes on port 3000...');
    await killProcessOnPort(3000);

    // Give macOS CI more time for complete port cleanup
    const cleanupTime =
      process.platform === 'darwin' && process.env.CI === 'true'
        ? TEST_TIMEOUTS.MEDIUM_WAIT
        : TEST_TIMEOUTS.SHORT_WAIT;
    console.log(`[DEBUG] Waiting ${cleanupTime}ms for port cleanup...`);
    await new Promise((resolve) => setTimeout(resolve, cleanupTime));

    // Create database directory
    await mkdir(join(testTmpDir, 'elizadb'), { recursive: true });

    // Start the ElizaOS server with a default character
    console.log(`[DEBUG] Starting ElizaOS server on port ${testServerPort}`);
    // Use resolved path for CLI
    const cliPath = join(__dirname, '../../dist/index.js');
    console.log(`[DEBUG] __dirname: ${__dirname}`);
    console.log(`[DEBUG] CLI path: ${cliPath}`);
    console.log(`[DEBUG] CLI exists: ${existsSync(cliPath)}`);

    const defaultCharacter = join(__dirname, '../test-characters', 'ada.json');
    console.log(`[DEBUG] Character path: ${defaultCharacter}`);
    console.log(`[DEBUG] Character exists: ${existsSync(defaultCharacter)}`);

    // Skip agent tests if CLI is not built
    if (!existsSync(cliPath)) {
      console.error('[ERROR] CLI not built. Run "bun run build" in the CLI package first.');
      throw new Error('CLI not built');
    }

    // Also verify templates are available
    const templatesPath = join(__dirname, '../../dist/templates');
    if (!existsSync(templatesPath)) {
      console.error('[ERROR] CLI templates not found in dist. Build may have failed.');
      console.error(`[ERROR] Expected templates at: ${templatesPath}`);
      throw new Error('CLI templates not built');
    }

    // Spawn server process using Bun.spawn
    const serverBunPath = getBunPath();
    console.log(`[DEBUG] Spawning server with: ${serverBunPath} ${cliPath} start`);

    try {
      const proc = Bun.spawn(
        [
          serverBunPath,
          cliPath,
          'start',
          '--port',
          testServerPort,
          '--character',
          defaultCharacter,
        ],
        {
          env: {
            ...process.env,
            LOG_LEVEL: 'error',
            PGLITE_DATA_DIR: `${testTmpDir}/elizadb`,
            NODE_OPTIONS: '--max-old-space-size=4096',
            SERVER_HOST: '127.0.0.1',
          },
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
          // Windows-specific options
          ...(process.platform === 'win32' && {
            windowsHide: true,
            windowsVerbatimArguments: false,
          }),
        }
      );

      if (!proc.pid) {
        throw new Error('Failed to spawn server process - no PID returned');
      }

      // Wrap to maintain compatibility with existing code
      serverProcess = proc as any;
    } catch (spawnError) {
      console.error(`[ERROR] Failed to spawn server process:`, spawnError);
      console.error(`[ERROR] Command: ${serverBunPath} ${cliPath} start`);
      console.error(`[ERROR] Platform: ${process.platform}`);
      throw spawnError;
    }

    if (!serverProcess || !serverProcess.pid) {
      console.error('[ERROR] Failed to spawn server process');
      throw new Error('Failed to spawn server process');
    }

    // Capture server output for debugging
    let serverStarted = false;
    let serverError: Error | null = null;

    // Handle Bun.spawn's ReadableStream for stdout/stderr
    const handleStream = async (
      stream: ReadableStream<Uint8Array> | undefined,
      isError: boolean
    ) => {
      if (!stream) return;

      const reader = stream.getReader();
      const decoder = new TextDecoder();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const text = decoder.decode(value, { stream: true });

          if (isError) {
            console.error(`[SERVER STDERR] ${text}`);
            if (text.includes('Error') || text.includes('error')) {
              serverError = new Error(text);
            }
          } else {
            console.log(`[SERVER STDOUT] ${text}`);
            if (text.includes('Server started') || text.includes('listening')) {
              serverStarted = true;
            }
          }
        }
      } catch (err) {
        console.error(`[SERVER] Stream error:`, err);
        if (isError && !serverError) {
          serverError = err as Error;
        }
      } finally {
        reader.releaseLock();
      }
    };

    // Start reading both streams
    Promise.all([
      handleStream(serverProcess.stdout, false),
      handleStream(serverProcess.stderr, true),
    ]);

    // Handle process exit
    serverProcess.exited
      .then((code: number) => {
        console.log(`[SERVER EXIT] code: ${code}`);
        if (code !== 0 && !serverError) {
          serverError = new Error(`Server exited with code ${code}`);
        }
      })
      .catch((error: Error) => {
        console.error('[SERVER ERROR]', error);
        serverError = error;
      });

    // Wait for server to be ready
    console.log('[DEBUG] Waiting for server to be ready...');
    try {
      // Give server a moment to fail fast if there are immediate errors
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Check if server already exited with error
      if (serverError) {
        throw serverError;
      }

      await waitForServerReady(parseInt(testServerPort, 10), 30000); // 30 second timeout in tests
      console.log('[DEBUG] Server is ready!');
    } catch (error) {
      console.error('[ERROR] Server failed to start:', error);

      // Log current working directory and file paths for debugging
      console.error('[DEBUG] Current working directory:', process.cwd());
      console.error('[DEBUG] CLI path exists:', existsSync(cliPath));
      console.error(
        '[DEBUG] Templates exist:',
        existsSync(join(__dirname, '../../dist/templates'))
      );
      console.error('[DEBUG] Character exists:', existsSync(defaultCharacter));

      throw error;
    }

    // Pre-load additional test characters (ada is already loaded by server)
    const charactersDir = join(scriptDir, 'test-characters');
    for (const character of ['max', 'shaw']) {
      const characterPath = join(charactersDir, `${character}.json`);
      console.log(`[DEBUG] Loading character: ${character}`);

      try {
        const platformOptions = getPlatformOptions({
          stdio: 'pipe',
          timeout: 30000, // 30 second timeout for loading each character
        });

        execSync(
          `${elizaosCmd} agent start --remote-url ${testServerUrl} --character ${characterPath}`,
          platformOptions
        );
        console.log(`[DEBUG] Successfully loaded character: ${character}`);

        // Small wait between loading characters to avoid overwhelming the server
        await new Promise((resolve) => setTimeout(resolve, 500));
      } catch (e) {
        console.error(`[ERROR] Failed to load character ${character}:`, e);
        throw e;
      }
    }

    // Give characters time to register
    await new Promise((resolve) => setTimeout(resolve, TEST_TIMEOUTS.SHORT_WAIT));
  });

  afterAll(async () => {
    console.log('[CLEANUP] Starting test cleanup...');

    // Clean up the server process
    if (serverProcess) {
      try {
        console.log(`[CLEANUP] Killing server process PID: ${serverProcess.pid}`);

        // Kill the process group to ensure all child processes are terminated
        if (process.platform !== 'win32' && serverProcess.pid) {
          try {
            // Kill the entire process group
            process.kill(-serverProcess.pid, 'SIGTERM');
          } catch (e) {
            // Fallback to regular kill
            serverProcess.kill('SIGTERM');
          }
        } else {
          serverProcess.kill('SIGTERM');
        }

        // Wait for process to exit
        if (serverProcess.exited) {
          await Promise.race([
            serverProcess.exited,
            new Promise((resolve) => setTimeout(resolve, 3000)),
          ]);
        }

        // Force kill if still running
        if (serverProcess.exitCode === null) {
          console.log('[CLEANUP] Force killing server process...');
          serverProcess.kill('SIGKILL');
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      } catch (e) {
        console.error('[CLEANUP] Error killing server process:', e);
      }
    }

    // Kill any remaining processes on the test port
    console.log(`[CLEANUP] Killing any remaining processes on port ${testServerPort}...`);
    await killProcessOnPort(parseInt(testServerPort, 10));

    // Additional cleanup for any elizaos processes that might be hanging
    if (process.platform !== 'win32') {
      try {
        const { execSync } = await import('child_process');
        // Kill any remaining elizaos processes
        execSync('pkill -f "elizaos start" || true', { stdio: 'ignore' });
        execSync('pkill -f "bun.*dist/index.js start" || true', { stdio: 'ignore' });
      } catch (e) {
        // Ignore errors
      }
    }

    // Clean up temp directory
    if (testTmpDir) {
      try {
        await rm(testTmpDir, { recursive: true });
      } catch (e) {
        // Ignore cleanup errors
      }
    }

    console.log('[CLEANUP] Test cleanup complete');
  });

  it('agent help displays usage information', async () => {
    const result = execSync(`${elizaosCmd} agent --help`, getPlatformOptions({ encoding: 'utf8' }));
    expect(result).toContain('Usage: elizaos agent');
  });

  it('agent list returns agents', async () => {
    const result = execSync(
      `${elizaosCmd} agent list --remote-url ${testServerUrl}`,
      getPlatformOptions({
        encoding: 'utf8',
      })
    );
    expect(result).toMatch(/(Ada|Max|Shaw)/);
  });

  it('agent list works with JSON flag', async () => {
    const result = execSync(
      `${elizaosCmd} agent list --remote-url ${testServerUrl} --json`,
      getPlatformOptions({
        encoding: 'utf8',
      })
    );
    expect(result).toContain('[');
    expect(result).toContain('{');
    expect(result).toMatch(/(name|Name)/);
  });

  it('agent get shows details with name parameter', async () => {
    const result = execSync(
      `${elizaosCmd} agent get --remote-url ${testServerUrl} -c Ada`,
      getPlatformOptions({
        encoding: 'utf8',
      })
    );
    expect(result).toContain('Ada');
  });

  it('agent get with JSON flag shows character definition', async () => {
    const result = execSync(
      `${elizaosCmd} agent get --remote-url ${testServerUrl} -c Ada --json`,
      getPlatformOptions({
        encoding: 'utf8',
      })
    );
    expect(result).toMatch(/(name|Name)/);
    expect(result).toContain('Ada');
  });

  it('agent get with output flag saves to file', async () => {
    const outputFile = join(testTmpDir, 'output_ada.json');
    execSync(
      `${elizaosCmd} agent get --remote-url ${testServerUrl} -c Ada --output ${outputFile}`,
      getPlatformOptions({ encoding: 'utf8' })
    );

    const { readFile } = await import('fs/promises');
    const fileContent = await readFile(outputFile, 'utf8');
    expect(fileContent).toContain('Ada');
  });

  it('agent start loads character from file', async () => {
    const charactersDir = join(__dirname, '../test-characters');
    // Use max.json since ada is already loaded by the server
    const maxPath = join(charactersDir, 'max.json');

    try {
      const result = execSync(
        `${elizaosCmd} agent start --remote-url ${testServerUrl} --character ${maxPath}`,
        getPlatformOptions({ encoding: 'utf8' })
      );
      expect(result).toMatch(/(started successfully|created|already exists|already running)/);
    } catch (e: any) {
      // If it fails, check if it's because agent already exists
      const errorOutput = e.stdout || e.stderr || e.message || '';
      expect(errorOutput).toMatch(/(already exists|already running)/);
    }
  });

  it('agent start works with name parameter', async () => {
    try {
      execSync(
        `${elizaosCmd} agent start --remote-url ${testServerUrl} -c Ada`,
        getPlatformOptions({
          encoding: 'utf8',
        })
      );
      // Should succeed or already exist
    } catch (e: any) {
      const errorOutput = e.stdout || e.stderr || e.message || '';
      expect(errorOutput).toMatch(/already/);
    }
  });

  it('agent start handles non-existent agent fails', async () => {
    const nonExistentName = `NonExistent_${Date.now()}`;

    try {
      execSync(
        `${elizaosCmd} agent start --remote-url ${testServerUrl} -c ${nonExistentName}`,
        getPlatformOptions({
          encoding: 'utf8',
          stdio: 'pipe',
        })
      );
      // Should not reach here
      expect(false).toBe(true);
    } catch (e: any) {
      // The command should fail when agent doesn't exist
      expect(e.status).not.toBe(0);
    }
  });

  it('agent stop works after start', async () => {
    // Ensure Ada is started first
    try {
      execSync(
        `${elizaosCmd} agent start --remote-url ${testServerUrl} -c Ada`,
        getPlatformOptions({ stdio: 'pipe' })
      );
    } catch (e) {
      // May already be running
    }

    try {
      const result = execSync(
        `${elizaosCmd} agent stop --remote-url ${testServerUrl} -c Ada`,
        getPlatformOptions({
          encoding: 'utf8',
        })
      );
      expect(result).toMatch(/(stopped|Stopped)/);
    } catch (e: any) {
      const errorOutput = e.stdout || e.stderr || e.message || '';
      expect(errorOutput).toMatch(/(not running|not found)/);
    }
  });

  it('agent set updates configuration correctly', async () => {
    const configFile = join(testTmpDir, 'update_config.json');
    const configContent = JSON.stringify({
      system: 'Updated system prompt for testing',
    });

    const { writeFile } = await import('fs/promises');
    await writeFile(configFile, configContent);

    const result = execSync(
      `${elizaosCmd} agent set --remote-url ${testServerUrl} -c Ada -f ${configFile}`,
      getPlatformOptions({ encoding: 'utf8' })
    );
    expect(result).toMatch(/(updated|Updated)/);
  });

  it('agent full lifecycle management', async () => {
    // Start agent
    try {
      execSync(
        `${elizaosCmd} agent start --remote-url ${testServerUrl} -c Ada`,
        getPlatformOptions({
          encoding: 'utf8',
        })
      );
      // Should succeed or already exist
    } catch (e: any) {
      const errorOutput = e.stdout || e.stderr || e.message || '';
      expect(errorOutput).toMatch(/already/);
    }

    // Stop agent
    try {
      execSync(
        `${elizaosCmd} agent stop --remote-url ${testServerUrl} -c Ada`,
        getPlatformOptions({
          encoding: 'utf8',
        })
      );
      // Should succeed or not be running
    } catch (e: any) {
      const errorOutput = e.stdout || e.stderr || e.message || '';
      expect(errorOutput).toMatch(/not running/);
    }
  });

  // Run this test last to avoid killing the server that other tests depend on
  it('agent stop --all works for stopping all agents', async () => {
    // This tests the --all flag functionality using pkill
    // Placed at end to avoid interfering with other tests that need the server
    try {
      const result = execSync(
        `${elizaosCmd} agent stop --all`,
        getPlatformOptions({
          encoding: 'utf8',
          timeout: 10000, // 10 second timeout
        })
      );
      expect(result).toMatch(/(All ElizaOS agents stopped|stopped successfully)/);
    } catch (e: any) {
      // The command may succeed even if no agents are running
      // Handle case where stdout/stderr might be undefined
      const output = (e.stdout || '') + (e.stderr || '') + (e.message || '');
      expect(output).toMatch(
        /(stopped|All ElizaOS agents stopped|Windows|WSL|requires Unix-like commands)/
      );
    }
  });
});

function getBunPath(): string {
  // Use platform-specific bun executable
  return getBunExecutable();
}
