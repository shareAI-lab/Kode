#!/usr/bin/env bun
import { existsSync, rmSync, writeFileSync, chmodSync } from 'fs';

async function build() {
  console.log('🚀 Building Kode CLI...\n');
  
  try {
    // Clean previous builds
    console.log('🧹 Cleaning previous builds...');
    ['cli.js', '.npmrc'].forEach(file => {
      if (existsSync(file)) {
        rmSync(file, { recursive: true, force: true });
      }
    });
    // Ensure dist folder exists
    if (!existsSync('dist')) {
      // @ts-ignore
      await import('node:fs/promises').then(m => m.mkdir('dist', { recursive: true }))
    }
    
    // Create the CLI wrapper (prefer dist when available, then bun, then node+tsx)
    const wrapper = `#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Prefer dist (pure Node) if available, otherwise try bun, then node+tsx
const args = process.argv.slice(2);
const cliPath = path.join(__dirname, 'src', 'entrypoints', 'cli.tsx');
const distEntrypoint = path.join(__dirname, 'dist', 'entrypoints', 'cli.js');

// 1) Run compiled dist with Node if present (Windows-friendly, no bun/tsx needed)
try {
  if (fs.existsSync(distEntrypoint)) {
    const child = spawn(process.execPath, [distEntrypoint, ...args], {
      stdio: 'inherit',
      env: {
        ...process.env,
        YOGA_WASM_PATH: path.join(__dirname, 'yoga.wasm'),
      },
    });
    child.on('exit', code => process.exit(code || 0));
    child.on('error', () => runWithBunOrTsx());
    return;
  }
} catch (_) {
  // fallthrough to bun/tsx
}

// 2) Otherwise, try bun first, then fall back to node+tsx
runWithBunOrTsx();

function runWithBunOrTsx() {
  // Try bun first
  try {
    const { execSync } = require('child_process');
    execSync('bun --version', { stdio: 'ignore' });
    const child = spawn('bun', ['run', cliPath, ...args], {
      stdio: 'inherit',
      env: {
        ...process.env,
        YOGA_WASM_PATH: path.join(__dirname, 'yoga.wasm'),
      },
    });
    child.on('exit', code => process.exit(code || 0));
    child.on('error', () => runWithNodeTsx());
    return;
  } catch {
    // ignore and try tsx path
  }

  runWithNodeTsx();
}

function runWithNodeTsx() {
  // Use local tsx installation; if missing, try PATH-resolved tsx
  const binDir = path.join(__dirname, 'node_modules', '.bin')
  const tsxPath = process.platform === 'win32'
    ? path.join(binDir, 'tsx.cmd')
    : path.join(binDir, 'tsx')

  const runPathTsx = () => {
    const child2 = spawn('tsx', [cliPath, ...args], {
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: { 
        ...process.env, 
        YOGA_WASM_PATH: path.join(__dirname, 'yoga.wasm'),
        TSX_TSCONFIG_PATH: process.platform === 'win32' ? 'noop' : undefined
      },
    })
    child2.on('error', () => {
      console.error('\\nError: tsx is required but not found.')
      console.error('Please install tsx globally: npm install -g tsx')
      process.exit(1)
    })
    child2.on('exit', (code2) => process.exit(code2 || 0))
  }

  const child = spawn(tsxPath, [cliPath, ...args], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { 
      ...process.env, 
      YOGA_WASM_PATH: path.join(__dirname, 'yoga.wasm'),
      TSX_TSCONFIG_PATH: process.platform === 'win32' ? 'noop' : undefined
    },
  })
  
  child.on('error', () => runPathTsx())
  child.on('exit', (code) => {
    if (code && code !== 0) return runPathTsx()
    process.exit(code || 0)
  })
}
`;
    
    writeFileSync('cli.js', wrapper);
    chmodSync('cli.js', 0o755);

    // Create a slim dist/index.js that imports the real entrypoint
    const distIndex = `#!/usr/bin/env node
import './entrypoints/cli.js';
`;
    writeFileSync('dist/index.js', distIndex);
    chmodSync('dist/index.js', 0o755);
    // Create .npmrc
    const npmrc = `# Ensure tsx is installed
auto-install-peers=true
`;
    
    writeFileSync('.npmrc', npmrc);
    
    console.log('✅ Build completed successfully!\n');
    console.log('📋 Generated files:');
    console.log('  - cli.js (Smart CLI wrapper)');
    console.log('  - .npmrc (NPM configuration)');
    console.log('\n🚀 Ready to publish!');
    
  } catch (error) {
    console.error('❌ Build failed:', error);
    process.exit(1);
  }
}

// Run build if called directly
if (import.meta.main) {
  build();
}

export { build };
