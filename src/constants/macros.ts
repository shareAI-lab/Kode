import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const pkg = require('../../package.json')

export const MACRO = {
  VERSION: pkg.version,
  README_URL: 'https://docs.anthropic.com/s/claude-code',
  PACKAGE_URL: '@shareai-lab/kode',
  ISSUES_EXPLAINER: 'report the issue at https://github.com/shareAI-lab/kode/issues',
}
