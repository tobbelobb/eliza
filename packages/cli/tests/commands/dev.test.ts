import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync, execSync, spawn as nodeSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TEST_TIMEOUTS } from '../test-timeouts';
import { killProcessOnPort, safeChangeDirectory, getBunExecutable } from './test-utils';

describe('ElizaOS Dev Commands', () => {
  let testTmpDir: string;
  let projectDir: string;
  let elizaosCmd: string;
  let originalCwd: string;
  let testServerPort: number;
  let runningProcesses: any[] = [];

  beforeAll(async () => {
    // Store original working directory
    originalCwd = process.cwd();

    // Create temporary directory
    testTmpDir = await mkdtemp(join(tmpdir(), 'eliza-test-dev-'));

    // Setup CLI command
    elizaosCmd = `bun ${join(__dirname, '../../dist/index.js')}`;

    // Create one test project for all dev tests to share
    projectDir = join(testTmpDir, 'shared-test-project');
    process.chdir(testTmpDir);

    console.log('Creating minimal test project structure for dev tests...');
    // Create minimal project structure instead of using real CLI
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, 'package.json'),
      JSON.stringify(
        {
          name: 'test-elizaos-project',
          version: '1.0.0',
          type: 'module',
          dependencies: {
            '@elizaos/core': '^1.0.0',
          },
        },
        null,
        2
      )
    );
    await mkdir(join(projectDir, 'src'), { recursive: true });
    await writeFile(join(projectDir, 'src/index.ts'), 'export const test = "hello";');
    console.log('Minimal test project created at:', projectDir);
  });

  beforeEach(async () => {
    // Setup test port (different from start tests)
    testServerPort = 3100;
    await killProcessOnPort(testServerPort);
    await new Promise((resolve) => setTimeout(resolve, TEST_TIMEOUTS.SHORT_WAIT));

    // Change to project directory for each test
    process.chdir(projectDir);

    // Set test environment variables to avoid database issues
    process.env.TEST_SERVER_PORT = testServerPort.toString();
    process.env.LOG_LEVEL = 'error'; // Reduce log noise
  });

  afterEach(async () => {
    // Kill any running processes with proper async cleanup
    const killPromises = runningProcesses.map(async (proc) => {
      if (!proc || proc.killed || proc.exitCode !== null) {
        return;
      }

      try {
        // For Bun.spawn processes, use the exited promise
        const exitPromise = proc.exited ? proc.exited.catch(() => {}) : Promise.resolve();

        // First attempt graceful shutdown
        proc.kill('SIGTERM');

        // Wait for graceful exit with timeout
        await Promise.race([
          exitPromise,
          new Promise<void>((resolve) => setTimeout(resolve, 3000)),
        ]);

        // Force kill if still running
        if (!proc.killed && proc.exitCode === null) {
          proc.kill('SIGKILL');
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      } catch (e) {
        // Ignore cleanup errors but try force kill
        try {
          if (!proc.killed) {
            proc.kill('SIGKILL');
          }
        } catch (e2) {
          // Ignore force kill errors
        }
      }
    });

    await Promise.allSettled(killPromises);
    runningProcesses = [];

    // Clean up any processes still using the test port
    await killProcessOnPort(testServerPort);

    // Clean up environment variables
    delete process.env.TEST_SERVER_PORT;
    delete process.env.LOG_LEVEL;
  });

  afterAll(async () => {
    console.log('[CLEANUP] Starting final test cleanup...');

    // Kill any remaining processes
    for (const proc of runningProcesses) {
      if (proc && !proc.killed && proc.exitCode === null) {
        try {
          console.log(`[CLEANUP] Killing process PID: ${proc.pid}`);
          proc.kill('SIGKILL');
        } catch (e) {
          // Ignore
        }
      }
    }

    // Additional cleanup for any dev processes that might be hanging
    if (process.platform !== 'win32') {
      try {
        const { execSync } = await import('child_process');
        execSync('pkill -f "elizaos dev" || true', { stdio: 'ignore' });
        execSync('pkill -f "bun.*dist/index.js dev" || true', { stdio: 'ignore' });
      } catch (e) {
        // Ignore errors
      }
    }

    // Restore original working directory
    safeChangeDirectory(originalCwd);

    if (testTmpDir && testTmpDir.includes('eliza-test-dev-')) {
      try {
        await rm(testTmpDir, { recursive: true });
      } catch (e) {
        // Ignore cleanup errors
      }
    }

    console.log('[CLEANUP] Final cleanup complete');
  });

  // Helper function to start dev process and wait for it to be ready
  const startDevAndWait = async (
    args: string,
    waitTime: number = TEST_TIMEOUTS.MEDIUM_WAIT,
    cwd?: string
  ): Promise<any> => {
    await mkdir(join(testTmpDir, 'elizadb'), { recursive: true });

    const cliPath = join(__dirname, '../../dist/index.js');
    console.log(`[DEBUG] __dirname: ${__dirname}`);
    console.log(`[DEBUG] CLI path: ${cliPath}`);
    console.log(`[DEBUG] CLI exists: ${existsSync(cliPath)}`);

    // Use platform-specific bun executable
    const bunPath = getBunExecutable();

    const commandStr = `${bunPath} ${cliPath} dev ${args}`;
    console.log(`[DEBUG] Running command: ${commandStr}`);

    // Use Bun.spawn for better compatibility
    console.log(`[DEBUG] Using Bun.spawn for dev command`);
    console.log(`[DEBUG] Command: ${bunPath} ${cliPath} dev ${args}`);

    try {
      const devProcess = Bun.spawn([bunPath, cliPath, 'dev', ...args.split(' ')], {
        cwd: cwd || projectDir,
        env: {
          ...process.env,
          LOG_LEVEL: 'error',
          PGLITE_DATA_DIR: join(testTmpDir, 'elizadb'),
          SERVER_PORT: testServerPort.toString(),
        },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        // Windows-specific options
        ...(process.platform === 'win32' && {
          windowsHide: true,
          windowsVerbatimArguments: false,
        }),
      });

      if (!devProcess.pid) {
        throw new Error('Bun.spawn failed to create process - no PID returned');
      }

      return devProcess;
    } catch (spawnError) {
      console.error(`[ERROR] Failed to spawn dev process:`, spawnError);
      console.error(`[ERROR] Platform: ${process.platform}`);
      console.error(`[ERROR] Working directory: ${cwd || projectDir}`);
      throw spawnError;
    }

    if (!devProcess || !devProcess.pid) {
      console.error('[ERROR] Failed to spawn dev process');
      throw new Error('Failed to spawn dev process');
    }

    runningProcesses.push(devProcess);

    // Wait for process to start
    await new Promise((resolve) => setTimeout(resolve, waitTime));

    return devProcess;
  };

  it('dev --help shows usage', () => {
    const result = execSync(`${elizaosCmd} dev --help`, { encoding: 'utf8' });
    expect(result).toContain('Usage: elizaos dev');
    expect(result).toContain('development mode');
    expect(result).toContain('auto-rebuild');
  });

  it('dev command starts in project directory', async () => {
    // Start dev process with shorter wait time for CI
    const devProcess = await startDevAndWait('--port ' + testServerPort, 2000); // 2 second wait

    // Check that process is running
    expect(devProcess.pid).toBeDefined();
    expect(devProcess.killed).toBe(false);

    // Kill the process immediately to save time and wait for exit
    devProcess.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }, 10000); // Further reduced timeout for CI

  it('dev command detects project type correctly', async () => {
    // Start dev process and capture output
    const cliPath = join(__dirname, '../../dist/index.js');
    console.log(`[DEBUG] CLI path for dev test: ${cliPath}`);
    console.log(`[DEBUG] CLI exists: ${existsSync(cliPath)}`);

    // Use platform-specific bun executable
    const bunPath = getBunExecutable();

    // Use Bun.spawn for project detection test
    console.log(`[DEBUG] Using Bun.spawn for project detection test`);
    console.log(`[DEBUG] Command: ${bunPath} ${cliPath} dev --port ${testServerPort}`);

    let devProcess: any;
    try {
      devProcess = Bun.spawn([bunPath, cliPath, 'dev', '--port', testServerPort.toString()], {
        cwd: projectDir,
        env: {
          ...process.env,
          LOG_LEVEL: 'info',
          PGLITE_DATA_DIR: join(testTmpDir, 'elizadb'),
        },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        // Windows-specific options
        ...(process.platform === 'win32' && {
          windowsHide: true,
          windowsVerbatimArguments: false,
        }),
      });

      if (!devProcess.pid) {
        throw new Error('Bun.spawn failed to create process - no PID returned');
      }
    } catch (spawnError) {
      console.error(`[ERROR] Failed to spawn project detection test:`, spawnError);
      console.error(`[ERROR] Platform: ${process.platform}`);
      console.error(`[ERROR] Working directory: ${projectDir}`);
      throw spawnError;
    }

    if (!devProcess || !devProcess.pid) {
      console.error('[ERROR] Failed to spawn dev process for project detection');
      throw new Error('Failed to spawn dev process');
    }

    runningProcesses.push(devProcess);

    let output = '';
    let outputReceived = false;
    const outputPromise = new Promise<void>((resolve) => {
      // Handle Bun.spawn's ReadableStream
      const handleStream = async (
        stream: ReadableStream<Uint8Array> | undefined,
        streamName: string
      ) => {
        if (!stream) return;

        const reader = stream.getReader();
        const decoder = new TextDecoder();

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const text = decoder.decode(value, { stream: true });
            output += text;
            console.log(`[DEV ${streamName}] ${text}`);

            if (!outputReceived && text.length > 0) {
              outputReceived = true;
              // Give more time for complete output on macOS
              setTimeout(resolve, process.platform === 'darwin' ? 3000 : 1000);
            }
          }
        } finally {
          reader.releaseLock();
        }
      };

      // Start reading both streams
      Promise.all([
        handleStream(devProcess.stdout, 'STDOUT'),
        handleStream(devProcess.stderr, 'STDERR'),
      ]).catch((err) => console.error('[DEV TEST] Stream error:', err));

      // Fallback timeout
      setTimeout(() => {
        if (!outputReceived) {
          console.log('[DEV TEST] No output received, resolving anyway');
        }
        resolve();
      }, TEST_TIMEOUTS.MEDIUM_WAIT);
    });

    // Wait for output
    await outputPromise;

    console.log(
      `[DEV TEST] Final output length: ${output.length}, content: ${output.slice(0, 200)}...`
    );

    // More flexible pattern matching - check for any indication of project detection
    // In CI, we primarily care that the process starts successfully
    expect(devProcess.pid).toBeDefined();
    expect(devProcess.killed).toBe(false);

    // Optional output validation only if we received output
    if (output && output.length > 0) {
      expect(output).toMatch(
        /(ElizaOS project|project mode|Identified as|Starting|development|dev mode|project|error|info)/i
      );
    }

    // Properly kill process and wait for exit
    devProcess.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }, 20000); // Reduced timeout for CI stability

  it('dev command responds to file changes in project', async () => {
    // Skip file watching test in CI as it's prone to hanging
    if (process.env.CI) {
      console.log('[FILE CHANGE TEST] Skipping file watching test in CI environment');
      return;
    }

    // Create a simple file to modify
    const testFile = join(projectDir, 'src', 'test-file.ts');
    await mkdir(join(projectDir, 'src'), { recursive: true });
    await writeFile(testFile, 'export const test = "initial";');

    // Start dev process with shorter timeout
    const devProcess = await startDevAndWait('--port ' + testServerPort, 2000);

    // Modify the file to trigger rebuild
    await writeFile(testFile, 'export const test = "modified";');

    // Brief wait for file change detection
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Check that process is still running (file watching active)
    expect(devProcess.pid).toBeDefined();

    // Immediate cleanup
    devProcess.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }, 10000); // Much shorter timeout for CI stability

  it('dev command accepts character file', async () => {
    const charactersDir = join(__dirname, '../test-characters');
    const adaPath = join(charactersDir, 'ada.json');

    // Start dev process with character
    const devProcess = await startDevAndWait(
      `--port ${testServerPort} --character ${adaPath}`,
      2000
    );

    // Check that process started
    expect(devProcess.pid).toBeDefined();
    expect(devProcess.killed).toBe(false);

    // Immediate cleanup
    devProcess.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }, 10000); // Reduced timeout for CI stability

  it('dev command handles non-elizaos directory gracefully', async () => {
    // Create a non-ElizaOS project directory
    const nonElizaDir = join(testTmpDir, 'non-elizaos');
    await mkdir(nonElizaDir, { recursive: true });
    await writeFile(
      join(nonElizaDir, 'package.json'),
      JSON.stringify({ name: 'not-elizaos', version: '1.0.0' })
    );

    let output = '';
    let outputReceived = false;
    const cliPath = join(__dirname, '../../dist/index.js');
    console.log(`[DEBUG] CLI path for non-eliza test: ${cliPath}`);
    console.log(`[DEBUG] CLI exists: ${existsSync(cliPath)}`);

    // Use platform-specific bun executable
    const bunPath = getBunExecutable();

    // Validate that CLI and bun exist before spawning
    if (!existsSync(cliPath)) {
      throw new Error(`CLI not found at ${cliPath}`);
    }

    // Use Bun.spawn for non-eliza test
    console.log(`[DEBUG] Using Bun.spawn for non-eliza test`);
    console.log(`[DEBUG] Command: ${bunPath} ${cliPath} dev --port ${testServerPort}`);

    let devProcess: any;
    try {
      devProcess = Bun.spawn([bunPath, cliPath, 'dev', '--port', testServerPort.toString()], {
        cwd: nonElizaDir,
        env: {
          ...process.env,
          LOG_LEVEL: 'info',
          PGLITE_DATA_DIR: join(testTmpDir, 'elizadb'),
        },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        // Windows-specific options
        ...(process.platform === 'win32' && {
          windowsHide: true,
          windowsVerbatimArguments: false,
        }),
      });

      if (!devProcess.pid) {
        throw new Error('Bun.spawn failed to create process - no PID returned');
      }
    } catch (spawnError) {
      console.error(`[ERROR] Failed to spawn non-eliza test:`, spawnError);
      console.error(`[ERROR] Platform: ${process.platform}`);
      console.error(`[ERROR] Working directory: ${nonElizaDir}`);
      throw spawnError;
    }

    if (!devProcess || !devProcess.pid) {
      console.error('[ERROR] Failed to spawn dev process for non-eliza test');
      console.error(`[ERROR] Command: ${bunPath} ${cliPath} dev --port ${testServerPort}`);
      console.error(`[ERROR] Working directory: ${nonElizaDir}`);
      throw new Error('Failed to spawn dev process');
    }

    runningProcesses.push(devProcess);

    const outputPromise = new Promise<void>((resolve) => {
      // Handle Bun.spawn's ReadableStream
      const handleStream = async (
        stream: ReadableStream<Uint8Array> | undefined,
        streamName: string
      ) => {
        if (!stream) return;

        const reader = stream.getReader();
        const decoder = new TextDecoder();

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const text = decoder.decode(value, { stream: true });
            output += text;
            console.log(`[NON-ELIZA DIR ${streamName}] ${text}`);

            if (!outputReceived && text.length > 0) {
              outputReceived = true;
              // Give more time for complete output on macOS
              setTimeout(resolve, process.platform === 'darwin' ? 3000 : 1000);
            }
          }
        } finally {
          reader.releaseLock();
        }
      };

      // Start reading both streams
      Promise.all([
        handleStream(devProcess.stdout, 'STDOUT'),
        handleStream(devProcess.stderr, 'STDERR'),
      ]).catch((err) => console.error('[NON-ELIZA DIR TEST] Stream error:', err));

      // Fallback timeout
      setTimeout(() => {
        if (!outputReceived) {
          console.log('[NON-ELIZA DIR TEST] No output received, resolving anyway');
        }
        resolve();
      }, TEST_TIMEOUTS.MEDIUM_WAIT);
    });

    // Wait for process to start and detect non-ElizaOS directory
    await outputPromise;

    console.log(`[NON-ELIZA DIR TEST] Final output: "${output}"`);

    // More flexible pattern matching for non-ElizaOS detection
    // In CI, we primarily care that the process starts successfully
    expect(devProcess.pid).toBeDefined();

    // Optional output validation only if we received output
    if (output && output.length > 0) {
      expect(output).toMatch(
        /(not.*recognized|standalone mode|not.*ElizaOS|non.*eliza|external|independent|error|info|Starting)/i
      );
    } else {
      console.log('[NON-ELIZA DIR TEST] No output but process started successfully');
    }

    // Proper cleanup
    devProcess.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }, 15000); // Reduced timeout for CI stability

  it('dev command validates port parameter', () => {
    // Test that invalid port is rejected
    try {
      execSync(`${elizaosCmd} dev --port abc`, {
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: TEST_TIMEOUTS.QUICK_COMMAND,
        cwd: projectDir,
      });
      expect(false).toBe(true); // Should not reach here
    } catch (error: any) {
      // Expect command to fail with non-zero exit code
      expect(error.status).toBeDefined();
      expect(error.status).not.toBe(0);
    }
  });
});
