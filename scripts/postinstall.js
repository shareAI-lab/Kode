#!/usr/bin/env node

// This postinstall is intentionally minimal and cross-platform safe.
// npm/pnpm/yarn already create shims from package.json "bin" fields.
// We avoid attempting to create symlinks or relying on platform-specific tools like `which`/`where`.

function postinstallNotice() {
  // Only print informational hints; never fail install.
  try {
    console.log('✅ @shareai-lab/kode installed. Commands available: kode, kwa, kd');
    console.log('   If shell cannot find them, try reloading your terminal or reinstall globally:');
    console.log('   npm i -g @shareai-lab/kode  (or use: npx @shareai-lab/kode)');
  } catch {}
}

if (process.env.npm_lifecycle_event === 'postinstall') {
  postinstallNotice();
}
