---
sidebar_position: 7
title: Development Mode
description: Run ElizaOS projects in development mode with hot reloading and debugging
keywords: [development, hot reload, debugging, watch mode, local development]
image: /img/cli.jpg
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Dev Command

Start the project or plugin in development mode with auto-rebuild, detailed logging, and file change detection.

<Tabs>
<TabItem value="overview" label="Overview & Options" default>

## Usage

```bash
elizaos dev [options]
```

## Options

| Option                   | Description                                                          |
| ------------------------ | -------------------------------------------------------------------- |
| `-c, --configure`        | Reconfigure services and AI models (skips using saved configuration) |
| `--character [paths...]` | Character file(s) to use - accepts paths or URLs                     |
| `-b, --build`            | Build the project before starting                                    |
| `-p, --port <port>`      | Port to listen on                                                    |

</TabItem>
<TabItem value="examples" label="Examples">

### Basic Development Mode

```bash
# Navigate to your project directory
cd my-agent-project

# Start development mode
elizaos dev
```

### Development with Configuration

```bash
# Start dev mode with custom port
elizaos dev --port 8080

# Force reconfiguration of services
elizaos dev --configure

# Build before starting development
elizaos dev --build
```

### Character File Specification

```bash
# Single character file
elizaos dev --character assistant.json

# Multiple character files (space-separated)
elizaos dev --character assistant.json chatbot.json

# Multiple character files (comma-separated)
elizaos dev --character "assistant.json,chatbot.json"

# Character file without extension (auto-adds .json)
elizaos dev --character assistant

# Load character from URL
elizaos dev --character https://example.com/characters/assistant.json
```

### Combined Options

```bash
# Full development setup
elizaos dev --port 4000 --character "assistant.json,chatbot.json" --build --configure
```

</TabItem>
<TabItem value="guides" label="Guides & Concepts">

## Development Features

The dev command provides comprehensive development capabilities:

### Auto-Rebuild and Restart

- **File Watching**: Monitors `.ts`, `.js`, `.tsx`, and `.jsx` files for changes
- **Automatic Rebuilding**: Rebuilds project when source files change
- **Server Restart**: Automatically restarts the server after successful rebuilds
- **TypeScript Support**: Compiles TypeScript files during rebuilds

### Project Detection

- **Project Mode**: Automatically detects Eliza projects based on package.json configuration
- **Plugin Mode**: Detects and handles plugin development appropriately
- **Monorepo Support**: Builds core packages when working in monorepo context

### Development Workflow

1. Detects whether you're in a project or plugin directory
2. Performs initial build (if needed)
3. Starts the server with specified options
4. Sets up file watching for source files
5. Rebuilds and restarts when files change

### Plugin Loading in Development

Plugins are loaded from character files during development:

```json
{
  "name": "DevAssistant",
  "plugins": [
    "@elizaos/plugin-openai",
    "./path/to/local/plugin" // Local plugins supported
  ]
}
```

The runtime automatically installs missing plugins and supports local plugin development paths.

## File Watching Behavior

### Watched Files

- TypeScript files (`.ts`, `.tsx`)
- JavaScript files (`.js`, `.jsx`)

### Watched Directories

- Source directory (`src/`)
- Project root (if no src directory exists)

### Ignored Paths

- `node_modules/` directory
- `dist/` directory
- `.git/` directory

### Debouncing

- Changes are debounced with a 300ms delay to prevent rapid rebuilds
- Multiple rapid changes trigger only one rebuild cycle

## Project Type Detection

The dev command uses intelligent project detection:

### Plugin Detection

Identifies plugins by checking for:

- `eliza.type: "plugin"` in package.json
- Package name containing `plugin-`
- Keywords: `elizaos-plugin` or `eliza-plugin`

### Project Detection

Identifies projects by checking for:

- `eliza.type: "project"` in package.json
- Package name containing `project-` or `-org`
- Keywords: `elizaos-project` or `eliza-project`
- `src/index.ts` with Project export

## Monorepo Support

When running in a monorepo context, the dev command:

1. **Builds Core Packages**: Automatically builds essential monorepo packages:

   - `packages/core`
   - `packages/client`
   - `packages/plugin-bootstrap`

2. **Dependency Resolution**: Ensures proper build order for dependencies

3. **Change Detection**: Monitors both core packages and current project for changes

## Development Logs

The dev command provides detailed logging:

```bash
# Project detection
[info] Running in project mode
[info] Package name: my-agent-project

# Build process
[info] Building project...
[success] Build successful

# Server management
[info] Starting server...
[info] Stopping current server process...

# File watching
[info] Setting up file watching for directory: /path/to/project
[success] File watching initialized in: /path/to/project/src
[info] Found 15 TypeScript/JavaScript files in the watched directory

# Change detection
[info] File event: change - src/index.ts
[info] Triggering rebuild for file change: src/index.ts
[info] Rebuilding project after file change...
[success] Rebuild successful, restarting server...
```

## Character File Handling

### Supported Formats

- **Local files**: Relative or absolute paths
- **URLs**: HTTP/HTTPS URLs to character files
- **Extension optional**: `.json` extension is automatically added if missing

### Multiple Characters

Multiple character files can be specified using:

- Space separation: `file1.json file2.json`
- Comma separation: `"file1.json,file2.json"`
- Mixed format: `"file1.json, file2.json"`

### Plugin Development Workflow

When developing plugins locally:

1. Create your plugin within your project or in a separate directory:

   ```bash
   # Option 1: Create plugin within project
   elizaos create --type plugin my-plugin

   # Option 2: Create plugin in separate directory
   cd ../
   elizaos create --type plugin my-plugin
   cd my-agent-project
   ```

2. Reference it in your character file:

   ```json
   {
     "plugins": [
       "./plugin-my-plugin", // Plugin within project
       "../plugin-my-plugin", // Plugin in sibling directory
       "@elizaos/plugin-openai" // Published plugin
     ]
   }
   ```

3. The dev command will watch both your project and plugin files
4. Changes to either will trigger rebuilds

</TabItem>
<TabItem value="troubleshooting" label="Troubleshooting">

## Troubleshooting

### Build Failures

```bash
# If initial build fails
[error] Initial build failed: Error message
[info] Continuing with dev mode anyway...

# Check for TypeScript errors
bun i && bun run build

# Try dev mode with explicit build
elizaos dev --build
```

### Bun Installation Issues

```bash
# If you see "bun: command not found" errors
# Install Bun using the appropriate command for your system:

# Linux/macOS:
curl -fsSL https://bun.sh/install | bash

# Windows:
powershell -c "irm bun.sh/install.ps1 | iex"

# macOS with Homebrew:
brew install bun

# After installation, restart your terminal or:
source ~/.bashrc  # Linux
source ~/.zshrc   # macOS with zsh

# Verify installation:
bun --version
```

### File Watching Issues

```bash
# If file changes aren't detected
[warn] No directories are being watched! File watching may not be working.

# Check if you're in the right directory
pwd
ls src/

# Verify file types being modified (.ts, .js, .tsx, .jsx)
```

### Server Restart Problems

```bash
# If server doesn't restart after changes
[warn] Failed to kill server process, trying force kill...

# Manual restart
# Press Ctrl+C to stop, then restart:
elizaos dev
```

### Port Conflicts

```bash
# If default port is in use
[error] Port 3000 already in use

# Use different port
elizaos dev --port 8080
```

### Plugin Loading Issues

```bash
# If plugins fail to load during development
# Check character file
cat character.json | jq .plugins

# Verify plugin paths
ls ./path/to/local/plugin

# Check npm registry for published plugins
bun info @elizaos/plugin-name
```

### Configuration Issues

```bash
# If having configuration problems
elizaos dev --configure

# Check environment setup
elizaos env list
```

## Related Commands

- [`start`](./start.md): Start your project in production mode
- [`test`](./test.md): Run tests for your project
- [`env`](./env.md): Configure environment variables for development
- [`create`](./create.md): Create new projects with development structure

</TabItem>
</Tabs>
