import {
  readFileSync,
  writeFileSync,
  openSync,
  readSync,
  closeSync,
  existsSync,
  readdirSync,
} from 'fs'
import { logError } from './log'
import {
  isAbsolute,
  normalize,
  resolve,
  resolve as resolvePath,
  relative,
  sep,
  basename,
  dirname,
  extname,
  join,
} from 'path'
import { glob as globLib } from 'glob'
import { cwd } from 'process'
import { listAllContentFiles } from './ripgrep'
import { LRUCache } from 'lru-cache'
import { getCwd } from './state'

export type File = {
  filename: string
  content: string
}

export type LineEndingType = 'CRLF' | 'LF'

export async function glob(
  filePattern: string,
  cwd: string,
  { limit, offset }: { limit: number; offset: number },
  abortSignal: AbortSignal,
): Promise<{ files: string[]; truncated: boolean }> {
  // TODO: Use worker threads
  const paths = await globLib([filePattern], {
    cwd,
    nocase: true,
    nodir: true,
    signal: abortSignal,
    stat: true,
    withFileTypes: true,
  })
  const sortedPaths = paths.sort((a, b) => (a.mtimeMs ?? 0) - (b.mtimeMs ?? 0))
  const truncated = sortedPaths.length > offset + limit
  return {
    files: sortedPaths
      .slice(offset, offset + limit)
      .map(path => path.fullpath()),
    truncated,
  }
}

export function readFileSafe(filepath: string): string | null {
  try {
    return readFileSync(filepath, 'utf-8')
  } catch (error) {
    logError(error)
    return null
  }
}

export function isInDirectory(
  relativePath: string,
  relativeCwd: string,
): boolean {
  if (relativePath === '.') {
    return true
  }

  // Reject paths starting with ~ (home directory)
  if (relativePath.startsWith('~')) {
    return false
  }

  // Reject paths containing null bytes or other sneaky characters
  if (relativePath.includes('\0') || relativeCwd.includes('\0')) {
    return false
  }

  // Normalize paths to resolve any '..' or '.' segments
  // and add trailing slashes
  let normalizedPath = normalize(relativePath)
  let normalizedCwd = normalize(relativeCwd)

  normalizedPath = normalizedPath.endsWith(sep)
    ? normalizedPath
    : normalizedPath + sep
  normalizedCwd = normalizedCwd.endsWith(sep)
    ? normalizedCwd
    : normalizedCwd + sep

  // Join with a base directory to make them absolute-like for comparison
  const fullPath = resolvePath(cwd(), normalizedCwd, normalizedPath)
  const fullCwd = resolvePath(cwd(), normalizedCwd)

  // Robust subpath check using path.relative (case-insensitive on Windows)
  const rel = relative(fullCwd, fullPath)
  if (!rel || rel === '') return true
  if (rel.startsWith('..')) return false
  if (isAbsolute(rel)) return false
  return true
}

export function readTextContent(
  filePath: string,
  offset = 0,
  maxLines?: number,
): { content: string; lineCount: number; totalLines: number } {
  const enc = detectFileEncoding(filePath)
  const content = readFileSync(filePath, enc)
  const lines = content.split(/\r?\n/)

  // Truncate number of lines if needed
  const toReturn =
    maxLines !== undefined && lines.length - offset > maxLines
      ? lines.slice(offset, offset + maxLines)
      : lines.slice(offset)

  return {
    content: toReturn.join('\n'), // TODO: This probably won't work for Windows
    lineCount: toReturn.length,
    totalLines: lines.length,
  }
}

export function writeTextContent(
  filePath: string,
  content: string,
  encoding: BufferEncoding,
  endings: LineEndingType,
): void {
  let toWrite = content
  if (endings === 'CRLF') {
    toWrite = content.split('\n').join('\r\n')
  }

  writeFileSync(filePath, toWrite, { encoding, flush: true })
}

const repoEndingCache = new LRUCache<string, LineEndingType>({
  fetchMethod: path => detectRepoLineEndingsDirect(path),
  ttl: 5 * 60 * 1000,
  ttlAutopurge: false,
  max: 1000,
})

export async function detectRepoLineEndings(
  filePath: string,
): Promise<LineEndingType | undefined> {
  return repoEndingCache.fetch(resolve(filePath))
}

export async function detectRepoLineEndingsDirect(
  cwd: string,
): Promise<LineEndingType> {
  const abortController = new AbortController()
  setTimeout(() => {
    abortController.abort()
  }, 1_000)
  const allFiles = await listAllContentFiles(cwd, abortController.signal, 15)

  let crlfCount = 0
  for (const file of allFiles) {
    const lineEnding = detectLineEndings(file)
    if (lineEnding === 'CRLF') {
      crlfCount++
    }
  }

  return crlfCount > 3 ? 'CRLF' : 'LF'
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
function fetch<K extends {}, V extends {}>(
  cache: LRUCache<K, V>,
  key: K,
  value: () => V,
): V {
  if (cache.has(key)) {
    return cache.get(key)!
  }

  const v = value()
  cache.set(key, v)
  return v
}

const fileEncodingCache = new LRUCache<string, BufferEncoding>({
  fetchMethod: path => detectFileEncodingDirect(path),
  ttl: 5 * 60 * 1000,
  ttlAutopurge: false,
  max: 1000,
})

export function detectFileEncoding(filePath: string): BufferEncoding {
  const k = resolve(filePath)
  return fetch(fileEncodingCache, k, () => detectFileEncodingDirect(k))
}

export function detectFileEncodingDirect(filePath: string): BufferEncoding {
  const BUFFER_SIZE = 4096
  const buffer = Buffer.alloc(BUFFER_SIZE)

  let fd: number | undefined = undefined
  try {
    fd = openSync(filePath, 'r')
    const bytesRead = readSync(fd, buffer, 0, BUFFER_SIZE, 0)

    if (bytesRead >= 2) {
      if (buffer[0] === 0xff && buffer[1] === 0xfe) return 'utf16le'
    }

    if (
      bytesRead >= 3 &&
      buffer[0] === 0xef &&
      buffer[1] === 0xbb &&
      buffer[2] === 0xbf
    ) {
      return 'utf8'
    }

    const isUtf8 = buffer.slice(0, bytesRead).toString('utf8').length > 0
    return isUtf8 ? 'utf8' : 'ascii'
  } catch (error) {
    logError(`Error detecting encoding for file ${filePath}: ${error}`)
    return 'utf8'
  } finally {
    if (fd) closeSync(fd)
  }
}

const lineEndingCache = new LRUCache<string, LineEndingType>({
  fetchMethod: path => detectLineEndingsDirect(path),
  ttl: 5 * 60 * 1000,
  ttlAutopurge: false,
  max: 1000,
})

export function detectLineEndings(filePath: string): LineEndingType {
  const k = resolve(filePath)
  return fetch(lineEndingCache, k, () => detectLineEndingsDirect(k))
}

export function detectLineEndingsDirect(
  filePath: string,
  encoding: BufferEncoding = 'utf8',
): LineEndingType {
  try {
    const buffer = Buffer.alloc(4096)
    const fd = openSync(filePath, 'r')
    const bytesRead = readSync(fd, buffer, 0, 4096, 0)
    closeSync(fd)

    const content = buffer.toString(encoding, 0, bytesRead)
    let crlfCount = 0
    let lfCount = 0

    for (let i = 0; i < content.length; i++) {
      if (content[i] === '\n') {
        if (i > 0 && content[i - 1] === '\r') {
          crlfCount++
        } else {
          lfCount++
        }
      }
    }

    return crlfCount > lfCount ? 'CRLF' : 'LF'
  } catch (error) {
    logError(`Error detecting line endings for file ${filePath}: ${error}`)
    return 'LF'
  }
}

export function normalizeFilePath(filePath: string): string {
  const absoluteFilePath = isAbsolute(filePath)
    ? filePath
    : resolve(getCwd(), filePath)

  // One weird trick for half-width space characters in MacOS screenshot filenames
  if (absoluteFilePath.endsWith(' AM.png')) {
    return absoluteFilePath.replace(
      ' AM.png',
      `${String.fromCharCode(8239)}AM.png`,
    )
  }

  // One weird trick for half-width space characters in MacOS screenshot filenames
  if (absoluteFilePath.endsWith(' PM.png')) {
    return absoluteFilePath.replace(
      ' PM.png',
      `${String.fromCharCode(8239)}PM.png`,
    )
  }

  return absoluteFilePath
}

export function getAbsolutePath(path: string | undefined): string | undefined {
  return path ? (isAbsolute(path) ? path : resolve(getCwd(), path)) : undefined
}

export function getAbsoluteAndRelativePaths(path: string | undefined): {
  absolutePath: string | undefined
  relativePath: string | undefined
} {
  const absolutePath = getAbsolutePath(path)
  const relativePath = absolutePath
    ? relative(getCwd(), absolutePath)
    : undefined
  return { absolutePath, relativePath }
}

/**
 * Find files with the same name but different extensions in the same directory
 * @param filePath The path to the file that doesn't exist
 * @returns The found file with a different extension, or undefined if none found
 */

export function findSimilarFile(filePath: string): string | undefined {
  try {
    const dir = dirname(filePath)
    const fileBaseName = basename(filePath, extname(filePath))

    // Check if directory exists
    if (!existsSync(dir)) {
      return undefined
    }

    // Get all files in the directory
    const files = readdirSync(dir)

    // Find files with the same base name but different extension
    const similarFiles = files.filter(
      file =>
        basename(file, extname(file)) === fileBaseName &&
        join(dir, file) !== filePath,
    )

    // Return just the filename of the first match if found
    const firstMatch = similarFiles[0]
    if (firstMatch) {
      return firstMatch
    }
    return undefined
  } catch (error) {
    // In case of any errors, return undefined
    logError(`Error finding similar file for ${filePath}: ${error}`)
    return undefined
  }
}

/**
 * Adds cat -n style line numbers to the content
 */
export function addLineNumbers({
  content,
  // 1-indexed
  startLine,
}: {
  content: string
  startLine: number
}): string {
  if (!content) {
    return ''
  }

  return content
    .split(/\r?\n/)
    .map((line, index) => {
      const lineNum = index + startLine
      const numStr = String(lineNum)
      // Handle large numbers differently
      if (numStr.length >= 6) {
        return `${numStr}\t${line}`
      }
      // Regular numbers get padding to 6 characters
      const n = numStr.padStart(6, ' ')
      return `${n}\t${line}`
    })
    .join('\n') // TODO: This probably won't work for Windows
}

/**
 * Checks if a directory is empty by efficiently reading just the first entry
 * @param dirPath The path to the directory to check
 * @returns true if the directory is empty, false otherwise
 */
export function isDirEmpty(dirPath: string): boolean {
  try {
    const entries = readdirSync(dirPath)
    return entries.length === 0
  } catch (error) {
    logError(`Error checking directory: ${error}`)
    return false
  }
}
