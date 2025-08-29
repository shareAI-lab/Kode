import { homedir } from 'os'
import { join } from 'path'
import {
  existsSync,
  mkdirSync,
  appendFileSync,
  readFileSync,
  constants,
  writeFileSync,
  unlinkSync,
  statSync,
} from 'fs'
import { platform } from 'process'
import { execFileNoThrow } from './execFileNoThrow'
import { spawn } from 'child_process'
import { logError } from './log'
import { accessSync } from 'fs'
import { CLAUDE_BASE_DIR } from './env'
import { logEvent, getDynamicConfig } from '../services/statsig'
import { lt, gt } from 'semver'
import { MACRO } from '../constants/macros'
import { PRODUCT_COMMAND, PRODUCT_NAME } from '../constants/product'
import { getGlobalConfig, saveGlobalConfig, isAutoUpdaterDisabled } from './config'
import { env } from './env'
export type InstallStatus =
  | 'success'
  | 'no_permissions'
  | 'install_failed'
  | 'in_progress'

export type AutoUpdaterResult = {
  version: string | null
  status: InstallStatus
}

export type VersionConfig = {
  minVersion: string
}

/**
 * Checks if the current version meets the minimum required version from Statsig config
 * Terminates the process with an error message if the version is too old
 */
export async function assertMinVersion(): Promise<void> {
  try {
    const versionConfig = await getDynamicConfig<VersionConfig>(
      'tengu_version_config',
      { minVersion: '0.0.0' },
    )

    if (
      versionConfig.minVersion &&
      lt(MACRO.VERSION, versionConfig.minVersion)
    ) {
      const suggestions = await getUpdateCommandSuggestions()
      const cmdLines = suggestions.map(c => `    ${c}`).join('\n')
      console.error(`
您的 ${PRODUCT_NAME} 版本 (${MACRO.VERSION}) 过低，需要升级到 ${versionConfig.minVersion} 或更高版本。
请手动执行以下任一命令进行升级：
${cmdLines}
`)
      process.exit(1)
    }
  } catch (error) {
    logError(`Error checking minimum version: ${error}`)
  }
}

// Lock file for auto-updater to prevent concurrent updates
export const LOCK_FILE_PATH = join(CLAUDE_BASE_DIR, '.update.lock')
const LOCK_TIMEOUT_MS = 5 * 60 * 1000 // 5 minute timeout for locks

/**
 * Attempts to acquire a lock for auto-updater
 * @returns {boolean} true if lock was acquired, false if another process holds the lock
 */
function acquireLock(): boolean {
  try {
    // Ensure the base directory exists
    if (!existsSync(CLAUDE_BASE_DIR)) {
      mkdirSync(CLAUDE_BASE_DIR, { recursive: true })
    }

    // Check if lock file exists and is not stale
    if (existsSync(LOCK_FILE_PATH)) {
      const stats = statSync(LOCK_FILE_PATH)
      const age = Date.now() - stats.mtimeMs

      // If lock file is older than timeout, consider it stale
      if (age < LOCK_TIMEOUT_MS) {
        return false
      }

      // Lock is stale, we can take over
      try {
        unlinkSync(LOCK_FILE_PATH)
      } catch (err) {
        logError(`Failed to remove stale lock file: ${err}`)
        return false
      }
    }

    // Create lock file with current pid
    writeFileSync(LOCK_FILE_PATH, `${process.pid}`, 'utf8')
    return true
  } catch (err) {
    logError(`Failed to acquire lock: ${err}`)
    return false
  }
}

/**
 * Releases the update lock if it's held by this process
 */
function releaseLock(): void {
  try {
    if (existsSync(LOCK_FILE_PATH)) {
      const lockData = readFileSync(LOCK_FILE_PATH, 'utf8')
      if (lockData === `${process.pid}`) {
        unlinkSync(LOCK_FILE_PATH)
      }
    }
  } catch (err) {
    logError(`Failed to release lock: ${err}`)
  }
}

export async function checkNpmPermissions(): Promise<{
  hasPermissions: boolean
  npmPrefix: string | null
}> {
  try {
    const prefixResult = await execFileNoThrow('npm', [
      '-g',
      'config',
      'get',
      'prefix',
    ])
    if (prefixResult.code !== 0) {
      logError('Failed to check npm permissions')
      return { hasPermissions: false, npmPrefix: null }
    }

    const prefix = prefixResult.stdout.trim()

    let testWriteResult = false
    try {
      accessSync(prefix, constants.W_OK)
      testWriteResult = true
    } catch {
      testWriteResult = false
    }

    if (testWriteResult) {
      return { hasPermissions: true, npmPrefix: prefix }
    }

    logError('Insufficient permissions for global npm install.')
    return { hasPermissions: false, npmPrefix: prefix }
  } catch (error) {
    logError(`Failed to verify npm global install permissions: ${error}`)
    return { hasPermissions: false, npmPrefix: null }
  }
}

export async function setupNewPrefix(prefix: string): Promise<void> {
  if (!acquireLock()) {
    // Log the lock contention to statsig
    logEvent('tengu_auto_updater_prefix_lock_contention', {
      pid: String(process.pid),
      currentVersion: MACRO.VERSION,
      prefix,
    })
    throw new Error('Another process is currently setting up npm prefix')
  }

  try {
    // Create directory if it doesn't exist
    if (!existsSync(prefix)) {
      mkdirSync(prefix, { recursive: true })
    }

    // Set npm prefix
    const setPrefix = await execFileNoThrow('npm', [
      '-g',
      'config',
      'set',
      'prefix',
      prefix,
    ])

    if (setPrefix.code !== 0) {
      throw new Error(`Failed to set npm prefix: ${setPrefix.stderr}`)
    }

    // Update shell config files
    const pathUpdate = `\n# npm global path\nexport PATH="${prefix}/bin:$PATH"\n`

    if (platform === 'win32') {
      // On Windows, update user PATH environment variable
      const setxResult = await execFileNoThrow('setx', [
        'PATH',
        `${process.env.PATH};${prefix}`,
      ])
      if (setxResult.code !== 0) {
        throw new Error(
          `Failed to update PATH on Windows: ${setxResult.stderr}`,
        )
      }
    } else {
      // Unix-like systems
      const shellConfigs = [
        // Bash
        join(homedir(), '.bashrc'),
        join(homedir(), '.bash_profile'),
        // Zsh
        join(homedir(), '.zshrc'),
        // Fish
        join(homedir(), '.config', 'fish', 'config.fish'),
      ]

      for (const config of shellConfigs) {
        if (existsSync(config)) {
          try {
            const content = readFileSync(config, 'utf8')
            if (!content.includes(prefix)) {
              if (config.includes('fish')) {
                // Fish shell has different syntax
                const fishPath = `\n# npm global path\nset -gx PATH ${prefix}/bin $PATH\n`
                appendFileSync(config, fishPath)
              } else {
                appendFileSync(config, pathUpdate)
              }

              logEvent('npm_prefix_path_updated', {
                configPath: config,
              })
            }
          } catch (err) {
            // Log but don't throw - continue with other configs
            logEvent('npm_prefix_path_update_failed', {
              configPath: config,
              error:
                err instanceof Error
                  ? err.message.slice(0, 200)
                  : String(err).slice(0, 200),
            })
            logError(`Failed to update shell config ${config}: ${err}`)
          }
        }
      }
    }
  } finally {
    releaseLock()
  }
}

export function getDefaultNpmPrefix(): string {
  return join(homedir(), '.npm-global')
}

export function getPermissionsCommand(npmPrefix: string): string {
  const windowsCommand = `icacls "${npmPrefix}" /grant "%USERNAME%:(OI)(CI)F"`
  const prefixPath = npmPrefix || '$(npm -g config get prefix)'
  const unixCommand = `sudo chown -R $USER:$(id -gn) ${prefixPath} && sudo chmod -R u+w ${prefixPath}`

  return platform === 'win32' ? windowsCommand : unixCommand
}

export async function getLatestVersion(): Promise<string | null> {
  // 1) Try npm CLI (fast when available)
  try {
    const abortController = new AbortController()
    setTimeout(() => abortController.abort(), 5000)
    const result = await execFileNoThrow(
      'npm',
      ['view', MACRO.PACKAGE_URL, 'version'],
      abortController.signal,
    )
    if (result.code === 0) {
      const v = result.stdout.trim()
      if (v) return v
    }
  } catch {}

  // 2) Fallback: fetch npm registry (works in Bun/Node without npm)
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)
    const res = await fetch(
      `https://registry.npmjs.org/${encodeURIComponent(MACRO.PACKAGE_URL)}`,
      {
        method: 'GET',
        headers: {
          Accept: 'application/vnd.npm.install-v1+json',
          'User-Agent': `${PRODUCT_NAME}/${MACRO.VERSION}`,
        },
        signal: controller.signal,
      },
    )
    clearTimeout(timer)
    if (!res.ok) return null
    const json: any = await res.json().catch(() => null)
    const latest = json && json['dist-tags'] && json['dist-tags'].latest
    return typeof latest === 'string' ? latest : null
  } catch {
    return null
  }
}

export async function installGlobalPackage(): Promise<InstallStatus> {
  // Detect preferred package manager and install accordingly
  if (!acquireLock()) {
    logError('Another process is currently installing an update')
    // Log the lock contention to statsig
    logEvent('tengu_auto_updater_lock_contention', {
      pid: String(process.pid),
      currentVersion: MACRO.VERSION,
    })
    return 'in_progress'
  }

  try {
    const manager = await detectPackageManager()
    if (manager === 'npm') {
      const { hasPermissions } = await checkNpmPermissions()
      if (!hasPermissions) {
        return 'no_permissions'
      }
      // Stream实时输出，减少用户等待感
      const code = await runStreaming('npm', ['install', '-g', MACRO.PACKAGE_URL])
      if (code !== 0) {
        logError(`Failed to install new version via npm (exit ${code})`)
        return 'install_failed'
      }
      return 'success'
    }

    if (manager === 'bun') {
      const code = await runStreaming('bun', ['add', '-g', `${MACRO.PACKAGE_URL}@latest`])
      if (code !== 0) {
        logError(`Failed to install new version via bun (exit ${code})`)
        return 'install_failed'
      }
      return 'success'
    }

    // Fallback to npm if unknown
    const { hasPermissions } = await checkNpmPermissions()
    if (!hasPermissions) return 'no_permissions'
    const code = await runStreaming('npm', ['install', '-g', MACRO.PACKAGE_URL])
    if (code !== 0) return 'install_failed'
    return 'success'
  } finally {
    // Ensure we always release the lock
    releaseLock()
  }
}

export type PackageManager = 'npm' | 'bun'

export async function detectPackageManager(): Promise<PackageManager> {
  // Respect explicit override if provided later via config/env (future-proof)
  try {
    // Heuristic 1: npm available and global root resolvable
    const npmRoot = await execFileNoThrow('npm', ['-g', 'root'])
    if (npmRoot.code === 0 && npmRoot.stdout.trim()) {
      return 'npm'
    }
  } catch {}

  try {
    // Heuristic 2: running on a system with bun and installed path hints bun
    const bunVer = await execFileNoThrow('bun', ['--version'])
    if (bunVer.code === 0) {
      // BUN_INSTALL defaults to ~/.bun; if our package lives under that tree, prefer bun
      // If npm not detected but bun is available, choose bun
      return 'bun'
    }
  } catch {}

  // Default to npm when uncertain
  return 'npm'
}

function runStreaming(cmd: string, args: string[]): Promise<number> {
  return new Promise(resolve => {
    // 打印正在使用的包管理器与命令，增强透明度
    try {
      // eslint-disable-next-line no-console
      console.log(`> ${cmd} ${args.join(' ')}`)
    } catch {}

    const child = spawn(cmd, args, {
      stdio: 'inherit',
      env: process.env,
    })
    child.on('close', code => resolve(code ?? 0))
    child.on('error', () => resolve(1))
  })
}

/**
 * Generate human-friendly update commands for the detected package manager.
 * Also includes an alternative manager command as fallback for users.
 */
export async function getUpdateCommandSuggestions(): Promise<string[]> {
  // Prefer Bun first, then npm (consistent, simple UX). Include @latest.
  return [
    `bun add -g ${MACRO.PACKAGE_URL}@latest`,
    `npm install -g ${MACRO.PACKAGE_URL}@latest`,
  ]
}

/**
 * Non-blocking update notifier (daily)
 * - Respects CI and disabled auto-updater
 * - Uses env.hasInternetAccess() to quickly skip offline cases
 * - Stores last check timestamp + last suggested version in global config
 */
export async function checkAndNotifyUpdate(): Promise<void> {
  try {
    if (process.env.NODE_ENV === 'test') return
    if (await isAutoUpdaterDisabled()) return
    if (await env.getIsDocker()) return
    if (!(await env.hasInternetAccess())) return

    const config: any = getGlobalConfig()
    const now = Date.now()
    const DAY_MS = 24 * 60 * 60 * 1000
    const lastCheck = Number(config.lastUpdateCheckAt || 0)
    if (lastCheck && now - lastCheck < DAY_MS) return

    const latest = await getLatestVersion()
    if (!latest) {
      // Still record the check to avoid spamming
      saveGlobalConfig({ ...config, lastUpdateCheckAt: now })
      return
    }

    if (gt(latest, MACRO.VERSION)) {
      // Update stored state and print a low-noise hint
      saveGlobalConfig({
        ...config,
        lastUpdateCheckAt: now,
        lastSuggestedVersion: latest,
      })
      const suggestions = await getUpdateCommandSuggestions()
      const first = suggestions[0]
      console.log(`New version available: ${latest}. Recommended: ${first}`)
    } else {
      saveGlobalConfig({ ...config, lastUpdateCheckAt: now })
    }
  } catch (error) {
    // Never block or throw; just log and move on
    logError(`update-notify: ${error}`)
  }
}
