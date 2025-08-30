#!/usr/bin/env node
import { build } from 'esbuild'
import { existsSync, mkdirSync, writeFileSync, cpSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname, dirname } from 'node:path'

const SRC_DIR = 'src'
const OUT_DIR = 'dist'

function collectEntries(dir, acc = []) {
  const items = readdirSync(dir)
  for (const name of items) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) {
      // skip tests and storybook or similar folders if any, adjust as needed
      if (name === 'test' || name === '__tests__') continue
      collectEntries(p, acc)
    } else if (st.isFile()) {
      if (p.endsWith('.ts') || p.endsWith('.tsx')) acc.push(p)
    }
  }
  return acc
}

function fixRelativeImports(dir) {
  const items = readdirSync(dir)
  for (const name of items) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) {
      fixRelativeImports(p)
      continue
    }
    if (!p.endsWith('.js')) continue
    let text = readFileSync(p, 'utf8')
    // Handle: from '...'
    text = text.replace(/(from\s+['"])(\.{1,2}\/[^'"\n]+)(['"])/gm, (m, a, spec, c) => {
      if (/\.(js|json|node|mjs|cjs)$/.test(spec)) return m
      return a + spec + '.js' + c
    })
    // Handle: export ... from '...'
    text = text.replace(/(export\s+[^;]*?from\s+['"])(\.{1,2}\/[^'"\n]+)(['"])/gm, (m, a, spec, c) => {
      if (/\.(js|json|node|mjs|cjs)$/.test(spec)) return m
      return a + spec + '.js' + c
    })
    // Handle: dynamic import('...')
    text = text.replace(/(import\(\s*['"])(\.{1,2}\/[^'"\n]+)(['"]\s*\))/gm, (m, a, spec, c) => {
      if (/\.(js|json|node|mjs|cjs)$/.test(spec)) return m
      return a + spec + '.js' + c
    })
    writeFileSync(p, text)
  }
}

async function main() {
  console.log('🚀 Building Kode CLI for cross-platform compatibility...')
  
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true })

  const entries = collectEntries(SRC_DIR)

  // Build ESM format but ensure Node.js compatibility
  await build({
    entryPoints: entries,
    outdir: OUT_DIR,
    outbase: SRC_DIR,
    bundle: false,
    platform: 'node',
    format: 'esm',
    target: ['node20'],
    sourcemap: true,
    legalComments: 'none',
    logLevel: 'info'  })

  // Fix relative import specifiers to include .js extension for ESM
  fixRelativeImports(OUT_DIR)

  // Mark dist as ES module
  writeFileSync(join(OUT_DIR, 'package.json'), JSON.stringify({
    type: 'module',
    main: './entrypoints/cli.js'
  }, null, 2))

  // Create a proper entrypoint - ESM with async handling
  const mainEntrypoint = join(OUT_DIR, 'index.js')
  writeFileSync(mainEntrypoint, `#!/usr/bin/env node
import('./entrypoints/cli.js').catch(err => {
  console.error('❌ Failed to load CLI:', err.message);
  process.exit(1);
});
`)

  // Copy yoga.wasm alongside outputs
  try {
    cpSync('yoga.wasm', join(OUT_DIR, 'yoga.wasm'))
    console.log('✅ yoga.wasm copied to dist')
  } catch (err) {
    console.warn('⚠️  Could not copy yoga.wasm:', err.message)
  }

  console.log('✅ Build completed for cross-platform compatibility!')
  console.log('📋 Generated files:')
  console.log('  - dist/ (CommonJS modules)')
  console.log('  - dist/index.js (main entrypoint)')
  console.log('  - dist/entrypoints/cli.js (CLI main)')
  console.log('  - cli.js (cross-platform wrapper)')
}

main().catch(err => {
  console.error('❌ Build failed:', err)
  process.exit(1)
})