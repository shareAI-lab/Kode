import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, unlinkSync, renameSync } from 'node:fs'
import { join, dirname, normalize, resolve, extname, relative, isAbsolute } from 'node:path'
import { homedir } from 'node:os'

/**
 * 安全文件系统操作服务
 * 解决文件系统操作中缺少适当验证和错误处理的问题
 */
export class SecureFileService {
  private static instance: SecureFileService
  private allowedBasePaths: Set<string>
  private maxFileSize: number
  private allowedExtensions: Set<string>

  private constructor() {
    // 允许的基础路径
    this.allowedBasePaths = new Set([
      process.cwd(),
      homedir(),
      '/tmp',
      '/var/tmp'
    ])
    
    // 默认最大文件大小 (10MB)
    this.maxFileSize = 10 * 1024 * 1024
    
    // 允许的文件扩展名
    this.allowedExtensions = new Set([
      '.txt', '.md', '.json', '.js', '.ts', '.tsx', '.jsx',
      '.yaml', '.yml', '.toml', '.ini', '.env', '.log',
      '.html', '.css', '.scss', '.less', '.xml', '.csv',
      '.py', '.go', '.rs', '.java', '.cpp', '.c', '.h',
      '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat',
      '.dockerfile', '.gitignore', '.npmignore', '.eslintignore'
    ])
  }

  public static getInstance(): SecureFileService {
    if (!SecureFileService.instance) {
      SecureFileService.instance = new SecureFileService()
    }
    return SecureFileService.instance
  }

  /**
   * 验证文件路径是否安全
   * @param filePath 文件路径
   * @returns 验证结果
   */
  public validateFilePath(filePath: string): { isValid: boolean; normalizedPath: string; error?: string } {
    try {
      // 规范化路径
      const normalizedPath = normalize(filePath)
      
      // 检查路径长度
      if (normalizedPath.length > 4096) {
        return {
          isValid: false,
          normalizedPath,
          error: 'Path too long (max 4096 characters)'
        }
      }

      // 检查是否包含路径遍历字符
      if (normalizedPath.includes('..') || normalizedPath.includes('~')) {
        return {
          isValid: false,
          normalizedPath,
          error: 'Path contains traversal characters'
        }
      }

      // 检查是否包含可疑的字符序列
      const suspiciousPatterns = [
        /\.\./,        // 父目录
        /~/,           // 用户目录
        /\$\{/,        // 环境变量
        /`/,           // 命令执行
        /\|/,          // 管道符
        /;/,           // 命令分隔符
        /&/,           // 后台执行
        />/,           // 输出重定向
        /</,           // 输入重定向
      ]

      for (const pattern of suspiciousPatterns) {
        if (pattern.test(normalizedPath)) {
          return {
            isValid: false,
            normalizedPath,
            error: `Path contains suspicious pattern: ${pattern}`
          }
        }
      }

      // 解析为绝对路径
      const absolutePath = resolve(normalizedPath)
      
      // 检查是否在允许的基础路径中
      const isInAllowedPath = Array.from(this.allowedBasePaths).some(basePath => {
        const base = resolve(basePath)
        const rel = relative(base, absolutePath)
        if (!rel || rel === '') return true
        if (rel.startsWith('..')) return false
        if (isAbsolute(rel)) return false
        return true
      })

      if (!isInAllowedPath) {
        return {
          isValid: false,
          normalizedPath,
          error: 'Path is outside allowed directories'
        }
      }

      return { isValid: true, normalizedPath: absolutePath }
    } catch (error) {
      return {
        isValid: false,
        normalizedPath: filePath,
        error: `Path validation failed: ${error instanceof Error ? error.message : String(error)}`
      }
    }
  }

  /**
   * 安全地检查文件是否存在
   * @param filePath 文件路径
   * @returns 文件是否存在
   */
  public safeExists(filePath: string): boolean {
    const validation = this.validateFilePath(filePath)
    if (!validation.isValid) {
      return false
    }

    try {
      return existsSync(validation.normalizedPath)
    } catch (error) {
      return false
    }
  }

  /**
   * 安全地读取文件
   * @param filePath 文件路径
   * @param options 读取选项
   * @returns 读取结果
   */
  public safeReadFile(
    filePath: string, 
    options: { 
      encoding?: BufferEncoding; 
      maxFileSize?: number;
      allowedExtensions?: string[];
      checkFileExtension?: boolean;
    } = {}
  ): { success: boolean; content?: string | Buffer; error?: string; stats?: any } {
    const validation = this.validateFilePath(filePath)
    if (!validation.isValid) {
      return { success: false, error: validation.error }
    }

    try {
      const normalizedPath = validation.normalizedPath
      
      // 检查文件扩展名（如果启用）
      if (options.checkFileExtension !== false) {
        const ext = extname(normalizedPath).toLowerCase()
        const allowedExts = options.allowedExtensions || 
                           Array.from(this.allowedExtensions)
        
        if (allowedExts.length > 0 && !allowedExts.includes(ext)) {
          return { 
            success: false, 
            error: `File extension '${ext}' is not allowed` 
          }
        }
      }

      // 检查文件是否存在
      if (!existsSync(normalizedPath)) {
        return { success: false, error: 'File does not exist' }
      }

      // 获取文件信息
      const stats = statSync(normalizedPath)
      const maxSize = options.maxFileSize || this.maxFileSize
      
      // 检查文件大小
      if (stats.size > maxSize) {
        return { 
          success: false, 
          error: `File too large (${stats.size} bytes, max ${maxSize} bytes)` 
        }
      }

      // 检查文件类型
      if (!stats.isFile()) {
        return { success: false, error: 'Path is not a file' }
      }

      // 检查文件权限
      if ((stats.mode & parseInt('400', 8)) === 0) { // 检查读权限
        return { success: false, error: 'No read permission' }
      }

      // 读取文件内容
      const content = readFileSync(normalizedPath, {
        encoding: options.encoding || 'utf8'
      })

      return { 
        success: true, 
        content,
        stats: {
          size: stats.size,
          mtime: stats.mtime,
          atime: stats.atime,
          mode: stats.mode
        }
      }
    } catch (error) {
      return { 
        success: false, 
        error: `Failed to read file: ${error instanceof Error ? error.message : String(error)}` 
      }
    }
  }

  /**
   * 安全地写入文件
   * @param filePath 文件路径
   * @param content 文件内容
   * @param options 写入选项
   * @returns 写入结果
   */
  public safeWriteFile(
    filePath: string, 
    content: string | Buffer, 
    options: { 
      encoding?: BufferEncoding; 
      createDirectory?: boolean;
      atomic?: boolean;
      mode?: number;
      allowedExtensions?: string[];
      checkFileExtension?: boolean;
      maxSize?: number;
    } = {}
  ): { success: boolean; error?: string } {
    const validation = this.validateFilePath(filePath)
    if (!validation.isValid) {
      return { success: false, error: validation.error }
    }

    try {
      const normalizedPath = validation.normalizedPath
      
      // 检查文件扩展名（如果启用）
      if (options.checkFileExtension !== false) {
        const ext = extname(normalizedPath).toLowerCase()
        const allowedExts = options.allowedExtensions || 
                           Array.from(this.allowedExtensions)
        
        if (allowedExts.length > 0 && !allowedExts.includes(ext)) {
          return { 
            success: false, 
            error: `File extension '${ext}' is not allowed` 
          }
        }
      }

      // 检查内容大小
      const contentSize = typeof content === 'string' ? 
        Buffer.byteLength(content, options.encoding as BufferEncoding || 'utf8') : 
        content.length
      
      const maxSize = options.maxSize || this.maxFileSize
      if (contentSize > maxSize) {
        return { 
          success: false, 
          error: `Content too large (${contentSize} bytes, max ${maxSize} bytes)` 
        }
      }

      // 创建目录（如果需要）
      if (options.createDirectory) {
        const dir = dirname(normalizedPath)
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true, mode: 0o755 })
        }
      }

      // 原子写入（如果启用）
      if (options.atomic) {
        const tempPath = `${normalizedPath}.tmp.${Date.now()}`
        
        try {
          // 写入临时文件
          writeFileSync(tempPath, content, {
            encoding: options.encoding as BufferEncoding || 'utf8',
            mode: options.mode || 0o644
          })
          
          // 重命名为目标文件
          renameSync(tempPath, normalizedPath)
        } catch (renameError) {
          // 清理临时文件
          try {
            if (existsSync(tempPath)) {
              unlinkSync(tempPath)
            }
          } catch {
            // 忽略清理错误
          }
          throw renameError
        }
      } else {
        // 直接写入
        writeFileSync(normalizedPath, content, {
          encoding: options.encoding as BufferEncoding || 'utf8',
          mode: options.mode || 0o644
        })
      }

      return { success: true }
    } catch (error) {
      return { 
        success: false, 
        error: `Failed to write file: ${error instanceof Error ? error.message : String(error)}` 
      }
    }
  }

  /**
   * 安全地删除文件
   * @param filePath 文件路径
   * @returns 删除结果
   */
  public safeDeleteFile(filePath: string): { success: boolean; error?: string } {
    const validation = this.validateFilePath(filePath)
    if (!validation.isValid) {
      return { success: false, error: validation.error }
    }

    try {
      const normalizedPath = validation.normalizedPath
      
      // 检查文件是否存在
      if (!existsSync(normalizedPath)) {
        return { success: false, error: 'File does not exist' }
      }

      // 检查文件类型
      const stats = statSync(normalizedPath)
      if (!stats.isFile()) {
        return { success: false, error: 'Path is not a file' }
      }

      // 检查写权限
      if ((stats.mode & parseInt('200', 8)) === 0) {
        return { success: false, error: 'No write permission' }
      }

      // 安全删除
      unlinkSync(normalizedPath)
      return { success: true }
    } catch (error) {
      return { 
        success: false, 
        error: `Failed to delete file: ${error instanceof Error ? error.message : String(error)}` 
      }
    }
  }

  /**
   * 安全地创建目录
   * @param dirPath 目录路径
   * @param mode 目录权限
   * @returns 创建结果
   */
  public safeCreateDirectory(dirPath: string, mode: number = 0o755): { success: boolean; error?: string } {
    const validation = this.validateFilePath(dirPath)
    if (!validation.isValid) {
      return { success: false, error: validation.error }
    }

    try {
      const normalizedPath = validation.normalizedPath
      
      if (existsSync(normalizedPath)) {
        const stats = statSync(normalizedPath)
        if (!stats.isDirectory()) {
          return { success: false, error: 'Path already exists and is not a directory' }
        }
        return { success: true }
      }

      mkdirSync(normalizedPath, { recursive: true, mode })
      return { success: true }
    } catch (error) {
      return { 
        success: false, 
        error: `Failed to create directory: ${error instanceof Error ? error.message : String(error)}` 
      }
    }
  }

  /**
   * 安全地获取文件信息
   * @param filePath 文件路径
   * @returns 文件信息
   */
  public safeGetFileInfo(filePath: string): { 
    success: boolean; 
    stats?: { 
      size: number; 
      isFile: boolean; 
      isDirectory: boolean; 
      mode: number; 
      atime: Date; 
      mtime: Date; 
      ctime: Date; 
    }; 
    error?: string 
  } {
    const validation = this.validateFilePath(filePath)
    if (!validation.isValid) {
      return { success: false, error: validation.error }
    }

    try {
      const normalizedPath = validation.normalizedPath
      
      if (!existsSync(normalizedPath)) {
        return { success: false, error: 'File does not exist' }
      }

      const stats = statSync(normalizedPath)
      
      return {
        success: true,
        stats: {
          size: stats.size,
          isFile: stats.isFile(),
          isDirectory: stats.isDirectory(),
          mode: stats.mode,
          atime: stats.atime,
          mtime: stats.mtime,
          ctime: stats.ctime
        }
      }
    } catch (error) {
      return { 
        success: false, 
        error: `Failed to get file info: ${error instanceof Error ? error.message : String(error)}` 
      }
    }
  }

  /**
   * 添加允许的基础路径
   * @param basePath 基础路径
   */
  public addAllowedBasePath(basePath: string): { success: boolean; error?: string } {
    try {
      const normalized = normalize(resolve(basePath))
      
      // 验证路径是否存在
      if (!existsSync(normalized)) {
        return { success: false, error: 'Base path does not exist' }
      }

      this.allowedBasePaths.add(normalized)
      return { success: true }
    } catch (error) {
      return { 
        success: false, 
        error: `Failed to add base path: ${error instanceof Error ? error.message : String(error)}` 
      }
    }
  }

  /**
   * 设置最大文件大小
   * @param maxSize 最大文件大小（字节）
   */
  public setMaxFileSize(maxSize: number): void {
    this.maxFileSize = maxSize
  }

  /**
   * 添加允许的文件扩展名
   * @param extensions 文件扩展名数组
   */
  public addAllowedExtensions(extensions: string[]): void {
    extensions.forEach(ext => {
      if (!ext.startsWith('.')) {
        ext = '.' + ext
      }
      this.allowedExtensions.add(ext.toLowerCase())
    })
  }

  /**
   * 检查文件是否在允许的基础路径中
   * @param filePath 文件路径
   * @returns 是否允许
   */
  public isPathAllowed(filePath: string): boolean {
    const validation = this.validateFilePath(filePath)
    return validation.isValid
  }

  /**
   * 验证文件名安全性
   * @param filename 文件名
   * @returns 验证结果
   */
  public validateFileName(filename: string): { isValid: boolean; error?: string } {
    // 检查文件名长度
    if (filename.length === 0) {
      return { isValid: false, error: 'Filename cannot be empty' }
    }

    if (filename.length > 255) {
      return { isValid: false, error: 'Filename too long (max 255 characters)' }
    }

    // 检查文件名字符
    const invalidChars = /[<>:"/\\|?*\x00-\x1F]/
    if (invalidChars.test(filename)) {
      return { isValid: false, error: 'Filename contains invalid characters' }
    }

    // 检查保留文件名
    const reservedNames = [
      'CON', 'PRN', 'AUX', 'NUL',
      'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
      'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'
    ]

    const baseName = filename.split('.')[0].toUpperCase()
    if (reservedNames.includes(baseName)) {
      return { isValid: false, error: 'Filename is reserved' }
    }

    // 检查是否以点开头或结尾
    if (filename.startsWith('.') || filename.endsWith('.')) {
      return { isValid: false, error: 'Filename cannot start or end with a dot' }
    }

    // 检查是否以空格开头或结尾
    if (filename.startsWith(' ') || filename.endsWith(' ')) {
      return { isValid: false, error: 'Filename cannot start or end with spaces' }
    }

    return { isValid: true }
  }
}

// 导出单例实例
export const secureFileService = SecureFileService.getInstance()
