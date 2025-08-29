import { isAbsolute, resolve, relative, sep } from 'path'
import { getCwd, getOriginalCwd } from '../state'

// In-memory storage for file permissions that resets each session
// Sets of allowed directories for read and write operations
const readFileAllowedDirectories: Set<string> = new Set()
const writeFileAllowedDirectories: Set<string> = new Set()

/**
 * Ensures a path is absolute by resolving it relative to cwd if necessary
 * @param path The path to normalize
 * @returns Absolute path
 */
export function toAbsolutePath(path: string): string {
  const abs = isAbsolute(path) ? resolve(path) : resolve(getCwd(), path)
  return normalizeForCompare(abs)
}

function normalizeForCompare(p: string): string {
  // Normalize separators and resolve .. and . segments
  const norm = resolve(p)
  // On Windows, comparisons should be case-insensitive
  return process.platform === 'win32' ? norm.toLowerCase() : norm
}

function isSubpath(base: string, target: string): boolean {
  const rel = relative(base, target)
  // If different drive letters on Windows, relative returns the target path
  if (!rel || rel === '') return true
  // Not a subpath if it goes up to parent
  if (rel.startsWith('..')) return false
  // Not a subpath if absolute
  if (isAbsolute(rel)) return false
  return true
}

/**
 * Ensures a path is in the original cwd path
 * @param directory The directory path to normalize
 * @returns Absolute path
 */
export function pathInOriginalCwd(path: string): boolean {
  const absolutePath = toAbsolutePath(path)
  const base = toAbsolutePath(getOriginalCwd())
  return isSubpath(base, absolutePath)
}

/**
 * Check if read permission exists for the specified directory
 * @param directory The directory to check permission for
 * @returns true if read permission exists, false otherwise
 */
export function hasReadPermission(directory: string): boolean {
  const absolutePath = toAbsolutePath(directory)
  for (const allowedPath of readFileAllowedDirectories) {
    if (isSubpath(allowedPath, absolutePath)) return true
  }
  return false
}

/**
 * Check if write permission exists for the specified directory
 * @param directory The directory to check permission for
 * @returns true if write permission exists, false otherwise
 */
export function hasWritePermission(directory: string): boolean {
  const absolutePath = toAbsolutePath(directory)
  for (const allowedPath of writeFileAllowedDirectories) {
    if (isSubpath(allowedPath, absolutePath)) return true
  }
  return false
}

/**
 * Save read permission for a directory
 * @param directory The directory to grant read permission for
 */
function saveReadPermission(directory: string): void {
  const absolutePath = toAbsolutePath(directory)
  // Remove any existing subpaths contained by this new path
  for (const allowedPath of Array.from(readFileAllowedDirectories)) {
    if (isSubpath(absolutePath, allowedPath)) {
      readFileAllowedDirectories.delete(allowedPath)
    }
  }
  readFileAllowedDirectories.add(absolutePath)
}

export const saveReadPermissionForTest = saveReadPermission

/**
 * Grants read permission for the original project directory.
 * This is useful for initializing read access to the project root.
 */
export function grantReadPermissionForOriginalDir(): void {
  const originalProjectDir = getOriginalCwd()
  saveReadPermission(originalProjectDir)
}

/**
 * Save write permission for a directory
 * @param directory The directory to grant write permission for
 */
function saveWritePermission(directory: string): void {
  const absolutePath = toAbsolutePath(directory)
  for (const allowedPath of Array.from(writeFileAllowedDirectories)) {
    if (isSubpath(absolutePath, allowedPath)) {
      writeFileAllowedDirectories.delete(allowedPath)
    }
  }
  writeFileAllowedDirectories.add(absolutePath)
}

/**
 * Grants write permission for the original project directory.
 * This is useful for initializing write access to the project root.
 */
export function grantWritePermissionForOriginalDir(): void {
  const originalProjectDir = getOriginalCwd()
  saveWritePermission(originalProjectDir)
}

// For testing purposes
export function clearFilePermissions(): void {
  readFileAllowedDirectories.clear()
  writeFileAllowedDirectories.clear()
}
