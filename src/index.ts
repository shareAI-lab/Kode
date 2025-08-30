// Unified CLI entry (lightweight)
// - Development: use `bun run src/entrypoints/cli.tsx`
// - Production: transpiled to `dist/index.js` and used as bin/main

import { createRequire } from 'module'
const require = createRequire(import.meta.url)

function hasFlag(...flags: string[]): boolean {
  return process.argv.some(arg => flags.includes(arg))
}

// Minimal pre-parse: handle version/help early without loading heavy UI modules
if (hasFlag('--version', '-v')) {
  try {
    const pkg = require('../package.json')
    console.log(pkg.version || '')
  } catch {
    console.log('')
  }
  process.exit(0)
}

if (hasFlag('--help-lite')) {
  console.log(`Usage: kode [options] [command] [prompt]\n\n` +
    `Common options:\n` +
    `  -h, --help           Show full help\n` +
    `  -v, --version        Show version\n` +
    `  -p, --print          Print response and exit (non-interactive)\n` +
    `  -c, --cwd <cwd>      Set working directory`)
  process.exit(0)
}

// For compatibility, --help loads full CLI help
await import('./entrypoints/cli.js')
