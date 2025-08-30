import React, { useState, useEffect, useMemo, useCallback, useReducer, Fragment } from 'react'
import { Box, Text, useInput } from 'ink'
import InkTextInput from 'ink-text-input'
import { getActiveAgents, clearAgentCache } from '../utils/agentLoader'
import { AgentConfig } from '../utils/agentLoader'
import { writeFileSync, unlinkSync, mkdirSync, existsSync, readFileSync, renameSync } from 'fs'
import { join } from 'path'
import * as path from 'path'
import { homedir } from 'os'
import * as os from 'os'
import { getCwd } from '../utils/state'
import { getTheme } from '../utils/theme'
import matter from 'gray-matter'
import { exec, spawn } from 'child_process'
import { promisify } from 'util'
import { watch, FSWatcher } from 'fs'
import { getMCPTools } from '../services/mcpClient'
import { getModelManager } from '../utils/model'
import { randomUUID } from 'crypto'

const execAsync = promisify(exec)

// Core constants aligned with Claude Code architecture
const AGENT_LOCATIONS = {
  USER: "user",
  PROJECT: "project", 
  BUILT_IN: "built-in",
  ALL: "all"
} as const

const UI_ICONS = {
  pointer: "❯",
  checkboxOn: "☑",
  checkboxOff: "☐", 
  warning: "⚠",
  separator: "─",
  loading: "◐◑◒◓"
} as const

const FOLDER_CONFIG = {
  FOLDER_NAME: ".claude",
  AGENTS_DIR: "agents"
} as const

// Tool categories for sophisticated selection
const TOOL_CATEGORIES = {
  read: ['Read', 'Glob', 'Grep', 'LS'],
  edit: ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'],
  execution: ['Bash', 'BashOutput', 'KillBash'],
  web: ['WebFetch', 'WebSearch'],
  other: ['TodoWrite', 'ExitPlanMode', 'Task']
} as const

type AgentLocation = typeof AGENT_LOCATIONS[keyof typeof AGENT_LOCATIONS]

// Models will be listed dynamically from ModelManager

// Comprehensive mode state for complete UI flow
type ModeState = {
  mode: 'list-agents' | 'create-location' | 'create-method' | 'create-generate' | 'create-type' | 
        'create-description' | 'create-tools' | 'create-model' | 'create-color' | 'create-prompt' | 'create-confirm' |
        'agent-menu' | 'view-agent' | 'edit-agent' | 'edit-tools' | 'edit-model' | 'edit-color' | 'delete-confirm'
  location?: AgentLocation
  selectedAgent?: AgentConfig
  previousMode?: ModeState
  [key: string]: any
}

// State for agent creation flow
type CreateState = {
  location: AgentLocation | null
  agentType: string
  method: 'generate' | 'manual' | null
  generationPrompt: string
  whenToUse: string
  selectedTools: string[]
  selectedModel: string | null // null for inherit, or model profile modelName
  selectedColor: string | null
  systemPrompt: string
  isGenerating: boolean
  wasGenerated: boolean
  isAIGenerated: boolean
  error: string | null
  warnings: string[]
  // Cursor positions for text inputs
  agentTypeCursor: number
  whenToUseCursor: number
  promptCursor: number
  generationPromptCursor: number
}

type Tool = {
  name: string
  description?: string | (() => Promise<string>)
}

// Map a stored model identifier to a display name via ModelManager
function getDisplayModelName(modelId?: string | null): string {
  // null/undefined means inherit from parent (task model)
  if (!modelId) return 'Inherit'
  
  try {
    const profiles = getModelManager().getActiveModelProfiles()
    const profile = profiles.find((p: any) => p.modelName === modelId || p.name === modelId)
    return profile ? profile.name : `Custom (${modelId})`
  } catch (error) {
    console.warn('Failed to get model profiles:', error)
    return modelId ? `Custom (${modelId})` : 'Inherit'
  }
}

// AI Generation response type
type GeneratedAgent = {
  identifier: string
  whenToUse: string
  systemPrompt: string
}

// AI generation function (use main pointer model)
async function generateAgentWithClaude(prompt: string): Promise<GeneratedAgent> {
  // Import Claude service dynamically to avoid circular dependencies
  const { queryModel } = await import('../services/claude')
  
  const systemPrompt = `You are an expert at creating AI agent configurations. Based on the user's description, generate a specialized agent configuration.

Return your response as a JSON object with exactly these fields:
- identifier: A short, kebab-case identifier for the agent (e.g., "code-reviewer", "security-auditor")
- whenToUse: A clear description of when this agent should be used (50-200 words)
- systemPrompt: A comprehensive system prompt that defines the agent's role, capabilities, and behavior (200-500 words)

Make the agent highly specialized and effective for the described use case.`

  try {
    const messages = [
      {
        type: 'user',
        uuid: randomUUID(),
        message: { role: 'user', content: prompt },
      },
    ] as any
    const response = await queryModel('main', messages, [systemPrompt])

    // Get the text content from the response - handle both string and object responses
    let responseText = ''
    if (typeof response.message?.content === 'string') {
      responseText = response.message.content
    } else if (Array.isArray(response.message?.content)) {
      const textContent = response.message.content.find((c: any) => c.type === 'text')
      responseText = textContent?.text || ''
    } else if (response.message?.content?.[0]?.text) {
      responseText = response.message.content[0].text
    }
    
    if (!responseText) {
      throw new Error('No text content in Claude response')
    }
    
    // 安全限制
    const MAX_JSON_SIZE = 100_000 // 100KB
    const MAX_FIELD_LENGTH = 10_000
    
    if (responseText.length > MAX_JSON_SIZE) {
      throw new Error('Response too large')
    }
    
    // 安全的JSON提取和解析
    let parsed: any
    try {
      // 首先尝试直接解析整个响应
      parsed = JSON.parse(responseText.trim())
    } catch {
      // 如果失败，提取第一个JSON对象，限制搜索范围
      const startIdx = responseText.indexOf('{')
      const endIdx = responseText.lastIndexOf('}')
      
      if (startIdx === -1 || endIdx === -1 || startIdx >= endIdx) {
        throw new Error('No valid JSON found in Claude response')
      }
      
      const jsonStr = responseText.substring(startIdx, endIdx + 1)
      if (jsonStr.length > MAX_JSON_SIZE) {
        throw new Error('JSON content too large')
      }
      
      try {
        parsed = JSON.parse(jsonStr)
      } catch (parseError) {
        throw new Error(`Invalid JSON format: ${parseError instanceof Error ? parseError.message : 'Unknown error'}`)
      }
    }
    
    // 深度验证和安全清理
    const identifier = String(parsed.identifier || '').slice(0, 100).trim()
    const whenToUse = String(parsed.whenToUse || '').slice(0, MAX_FIELD_LENGTH).trim()
    const agentSystemPrompt = String(parsed.systemPrompt || '').slice(0, MAX_FIELD_LENGTH).trim()
    
    // 验证必填字段
    if (!identifier || !whenToUse || !agentSystemPrompt) {
      throw new Error('Invalid response structure: missing required fields (identifier, whenToUse, systemPrompt)')
    }
    
    // 清理危险字符（控制字符和非打印字符）
    const sanitize = (str: string) => str.replace(/[\x00-\x1F\x7F-\x9F]/g, '')
    
    // 验证identifier格式（只允许字母、数字、连字符）
    const cleanIdentifier = sanitize(identifier)
    if (!/^[a-zA-Z0-9-]+$/.test(cleanIdentifier)) {
      throw new Error('Invalid identifier format: only letters, numbers, and hyphens allowed')
    }
    
    return {
      identifier: cleanIdentifier,
      whenToUse: sanitize(whenToUse),
      systemPrompt: sanitize(agentSystemPrompt)
    }
  } catch (error) {
    console.error('AI generation failed:', error)
    // Fallback to a reasonable default based on the prompt
    const fallbackId = prompt.toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .slice(0, 30)
    
    return {
      identifier: fallbackId || 'custom-agent',
      whenToUse: `Use this agent when you need assistance with: ${prompt}`,
      systemPrompt: `You are a specialized assistant focused on helping with ${prompt}. Provide expert-level assistance in this domain.`
    }
  }
}

// Comprehensive validation system
function validateAgentType(agentType: string, existingAgents: AgentConfig[] = []): { 
  isValid: boolean
  errors: string[]
  warnings: string[]
} {
  const errors: string[] = []
  const warnings: string[] = []
  
  if (!agentType) {
    errors.push("Agent type is required")
    return { isValid: false, errors, warnings }
  }
  
  if (!/^[a-zA-Z]/.test(agentType)) {
    errors.push("Agent type must start with a letter")
  }
  
  if (!/^[a-zA-Z0-9-]+$/.test(agentType)) {
    errors.push("Agent type can only contain letters, numbers, and hyphens")
  }
  
  if (agentType.length < 3) {
    errors.push("Agent type must be at least 3 characters long")
  }
  
  if (agentType.length > 50) {
    errors.push("Agent type must be less than 50 characters")
  }
  
  // Check for reserved names
  const reserved = ['help', 'exit', 'quit', 'agents', 'task']
  if (reserved.includes(agentType.toLowerCase())) {
    errors.push("This name is reserved")
  }
  
  // Check for duplicates
  const duplicate = existingAgents.find(a => a.agentType === agentType)
  if (duplicate) {
    errors.push(`An agent with this name already exists in ${duplicate.location}`)
  }
  
  // Warnings
  if (agentType.includes('--')) {
    warnings.push("Consider avoiding consecutive hyphens")
  }
  
  return {
    isValid: errors.length === 0,
    errors,
    warnings
  }
}

function validateAgentConfig(config: Partial<CreateState>, existingAgents: AgentConfig[] = []): {
  isValid: boolean
  errors: string[]
  warnings: string[]
} {
  const errors: string[] = []
  const warnings: string[] = []
  
  // Validate agent type
  if (config.agentType) {
    const typeValidation = validateAgentType(config.agentType, existingAgents)
    errors.push(...typeValidation.errors)
    warnings.push(...typeValidation.warnings)
  }
  
  // Validate description
  if (!config.whenToUse) {
    errors.push("Description is required")
  } else if (config.whenToUse.length < 10) {
    warnings.push("Description should be more descriptive (at least 10 characters)")
  }
  
  // Validate system prompt
  if (!config.systemPrompt) {
    errors.push("System prompt is required")
  } else if (config.systemPrompt.length < 20) {
    warnings.push("System prompt might be too short for effective agent behavior")
  }
  
  // Validate tools
  if (!config.selectedTools || config.selectedTools.length === 0) {
    warnings.push("No tools selected - agent will have limited capabilities")
  }
  
  return {
    isValid: errors.length === 0,
    errors,
    warnings
  }
}

// File system operations with Claude Code alignment
function getAgentDirectory(location: AgentLocation): string {
  if (location === AGENT_LOCATIONS.BUILT_IN || location === AGENT_LOCATIONS.ALL) {
    throw new Error(`Cannot get directory path for ${location} agents`)
  }
  
  if (location === AGENT_LOCATIONS.USER) {
    return join(homedir(), FOLDER_CONFIG.FOLDER_NAME, FOLDER_CONFIG.AGENTS_DIR)
  } else {
    return join(getCwd(), FOLDER_CONFIG.FOLDER_NAME, FOLDER_CONFIG.AGENTS_DIR)
  }
}

function getAgentFilePath(agent: AgentConfig): string {
  if (agent.location === 'built-in') {
    throw new Error('Cannot get file path for built-in agents')
  }
  const dir = getAgentDirectory(agent.location as AgentLocation)
  return join(dir, `${agent.agentType}.md`)
}

function ensureDirectoryExists(location: AgentLocation): string {
  const dir = getAgentDirectory(location)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

// Generate agent file content
function generateAgentFileContent(
  agentType: string,
  description: string,
  tools: string[] | '*',
  systemPrompt: string,
  model?: string,
  color?: string
): string {
  // Use YAML multi-line string for description to avoid escaping issues
  const descriptionLines = description.split('\n')
  const formattedDescription = descriptionLines.length > 1 
    ? `|\n  ${descriptionLines.join('\n  ')}`
    : JSON.stringify(description)
  
  const lines = [
    '---',
    `name: ${agentType}`,
    `description: ${formattedDescription}`
  ]
  
  if (tools) {
    if (tools === '*') {
      lines.push(`tools: "*"`)
    } else if (Array.isArray(tools) && tools.length > 0) {
      lines.push(`tools: [${tools.map(t => `"${t}"`).join(', ')}]`)
    }
  }
  
  if (model) {
    lines.push(`model: ${model}`)
  }
  
  if (color) {
    lines.push(`color: ${color}`)
  }
  
  lines.push('---', '', systemPrompt)
  return lines.join('\n')
}

// Save agent to file
async function saveAgent(
  location: AgentLocation,
  agentType: string,
  description: string,
  tools: string[],
  systemPrompt: string,
  model?: string,
  color?: string,
  throwIfExists: boolean = true
): Promise<void> {
  if (location === AGENT_LOCATIONS.BUILT_IN) {
    throw new Error('Cannot save built-in agents')
  }
  
  ensureDirectoryExists(location)
  
  const filePath = join(getAgentDirectory(location), `${agentType}.md`)
  const tempFile = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).substr(2, 9)}`
  
  // Ensure tools is properly typed for file saving
  const toolsForFile: string[] | '*' = Array.isArray(tools) && tools.length === 1 && tools[0] === '*' ? '*' : tools
  const content = generateAgentFileContent(agentType, description, toolsForFile, systemPrompt, model, color)
  
  try {
    // 先写入临时文件，使用 'wx' 确保不覆盖现有文件
    writeFileSync(tempFile, content, { encoding: 'utf-8', flag: 'wx' })
    
    // 检查目标文件是否存在（原子性检查）
    if (throwIfExists && existsSync(filePath)) {
      // 清理临时文件
      try { unlinkSync(tempFile) } catch {}
      throw new Error(`Agent file already exists: ${filePath}`)
    }
    
    // 原子性重命名（在大多数文件系统上，rename是原子操作）
    renameSync(tempFile, filePath)
    
  } catch (error) {
    // 确保清理临时文件
    try { 
      if (existsSync(tempFile)) {
        unlinkSync(tempFile) 
      }
    } catch (cleanupError) {
      console.warn('Failed to cleanup temp file:', cleanupError)
    }
    throw error
  }
}

// Delete agent file
async function deleteAgent(agent: AgentConfig): Promise<void> {
  if (agent.location === 'built-in') {
    throw new Error('Cannot delete built-in agents')
  }
  
  const filePath = getAgentFilePath(agent)
  unlinkSync(filePath)
}

// Open file in system editor - 安全版本，防止命令注入
async function openInEditor(filePath: string): Promise<void> {
  // 安全验证：确保路径在允许的目录内
  const resolvedPath = path.resolve(filePath)
  const projectDir = process.cwd()
  const homeDir = os.homedir()
  
  const isSub = (base: string, target: string) => {
    const path = require('path')
    const rel = path.relative(path.resolve(base), path.resolve(target))
    if (!rel || rel === '') return true
    if (rel.startsWith('..')) return false
    if (path.isAbsolute(rel)) return false
    return true
  }

  if (!isSub(projectDir, resolvedPath) && !isSub(homeDir, resolvedPath)) {
    throw new Error('Access denied: File path outside allowed directories')
  }
  
  // 验证文件扩展名
  if (!resolvedPath.endsWith('.md')) {
    throw new Error('Invalid file type: Only .md files are allowed')
  }
  
  return new Promise((resolve, reject) => {
    const platform = process.platform
    let command: string
    let args: string[]
    
    // 使用spawn而不是exec，避免shell注入
    switch (platform) {
      case 'darwin': // macOS
        command = 'open'
        args = [resolvedPath]
        break
      case 'win32': // Windows
        command = 'cmd'
        args = ['/c', 'start', '', resolvedPath]
        break
      default: // Linux and others
        command = 'xdg-open'
        args = [resolvedPath]
        break
    }
    
    // 使用spawn替代exec，避免shell解释
    const child = spawn(command, args, { 
      detached: true, 
      stdio: 'ignore',
      // 确保没有shell解释
      shell: false 
    })
    
    child.unref() // 允许父进程退出
    
    child.on('error', (error) => {
      reject(new Error(`Failed to open editor: ${error.message}`))
    })
    
    child.on('exit', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`Editor exited with code ${code}`))
      }
    })
  })
}

// Update existing agent
async function updateAgent(
  agent: AgentConfig,
  description: string,
  tools: string[] | '*',
  systemPrompt: string,
  color?: string,
  model?: string
): Promise<void> {
  if (agent.location === 'built-in') {
    throw new Error('Cannot update built-in agents')
  }
  
  const toolsForFile = tools.length === 1 && tools[0] === '*' ? '*' : tools
  const content = generateAgentFileContent(agent.agentType, description, toolsForFile, systemPrompt, model, color)
  const filePath = getAgentFilePath(agent)
  
  writeFileSync(filePath, content, { encoding: 'utf-8', flag: 'w' })
}

// Enhanced UI Components with Claude Code alignment

interface HeaderProps {
  title: string
  subtitle?: string
  step?: number
  totalSteps?: number
  children?: React.ReactNode
}

function Header({ title, subtitle, step, totalSteps, children }: HeaderProps) {
  const theme = getTheme()
  return (
    <Box flexDirection="column">
      <Text bold color={theme.primary}>{title}</Text>
      {subtitle && (
        <Text color={theme.secondary}>
          {step && totalSteps ? `Step ${step}/${totalSteps}: ` : ''}{subtitle}
        </Text>
      )}
      {children}
    </Box>
  )
}

interface InstructionBarProps {
  instructions?: string
}

function InstructionBar({ instructions = "Press ↑↓ to navigate · Enter to select · Esc to go back" }: InstructionBarProps) {
  const theme = getTheme()
  return (
    <Box marginTop={2}>
      <Box borderStyle="round" borderColor={theme.secondary} paddingX={1}>
        <Text color={theme.secondary}>{instructions}</Text>
      </Box>
    </Box>
  )
}

interface SelectListProps {
  options: Array<{ label: string; value: string }>
  selectedIndex: number
  onChange: (value: string) => void
  onCancel?: () => void
  numbered?: boolean
}

function SelectList({ options, selectedIndex, onChange, onCancel, numbered = true }: SelectListProps) {
  const theme = getTheme()
  
  useInput((input, key) => {
    if (key.escape && onCancel) {
      onCancel()
    } else if (key.return) {
      onChange(options[selectedIndex].value)
    }
  })

  return (
    <Box flexDirection="column">
      {options.map((option, idx) => (
        <Box key={option.value}>
          <Text color={idx === selectedIndex ? theme.primary : undefined}>
            {idx === selectedIndex ? `${UI_ICONS.pointer} ` : "  "}
            {numbered ? `${idx + 1}. ` : ''}{option.label}
          </Text>
        </Box>
      ))}
    </Box>
  )
}


// Multiline text input component with better UX
interface MultilineTextInputProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  onSubmit?: () => void
  focus?: boolean
  rows?: number
  error?: string | null
}

function MultilineTextInput({
  value,
  onChange,
  placeholder = '',
  onSubmit,
  focus = true,
  rows = 5,
  error
}: MultilineTextInputProps) {
  const theme = getTheme()
  const [internalValue, setInternalValue] = useState(value)
  const [cursorBlink, setCursorBlink] = useState(true)
  
  // Sync with external value changes
  useEffect(() => {
    setInternalValue(value)
  }, [value])
  
  // Cursor blink animation
  useEffect(() => {
    if (!focus) return
    const timer = setInterval(() => {
      setCursorBlink(prev => !prev)
    }, 500)
    return () => clearInterval(timer)
  }, [focus])
  
  // Calculate display metrics
  const lines = internalValue.split('\n')
  const lineCount = lines.length
  const charCount = internalValue.length
  const isEmpty = !internalValue.trim()
  const hasContent = !isEmpty
  
  // Format lines for display with word wrapping
  const formatLines = (text: string): string[] => {
    if (!text && placeholder) {
      return [placeholder]
    }
    const maxWidth = 70 // Maximum characters per line
    const result: string[] = []
    const textLines = text.split('\n')
    
    textLines.forEach(line => {
      if (line.length <= maxWidth) {
        result.push(line)
      } else {
        // Word wrap long lines
        let remaining = line
        while (remaining.length > 0) {
          result.push(remaining.slice(0, maxWidth))
          remaining = remaining.slice(maxWidth)
        }
      }
    })
    
    return result.length > 0 ? result : ['']
  }
  
  const displayLines = formatLines(internalValue)
  const visibleLines = displayLines.slice(Math.max(0, displayLines.length - rows))
  
  // Handle submit
  const handleSubmit = () => {
    if (internalValue.trim() && onSubmit) {
      onSubmit()
    }
  }
  
  return (
    <Box flexDirection="column" width="100%">
      {/* Modern card-style input container */}
      <Box flexDirection="column">
        {/* Input area */}
        <Box 
          borderStyle="round"
          borderColor={focus ? theme.primary : 'gray'}
          paddingX={2}
          paddingY={1}
          minHeight={rows + 2}
        >
          <Box flexDirection="column">
            {/* Use ink-text-input for better input handling */}
            <InkTextInput
              value={internalValue}
              onChange={(val) => {
                setInternalValue(val)
                onChange(val)
              }}
              onSubmit={handleSubmit}
              focus={focus}
              placeholder={placeholder}
            />
            
            {/* Show cursor indicator when focused */}
            {focus && cursorBlink && hasContent && (
              <Text color={theme.primary}>_</Text>
            )}
          </Box>
        </Box>
        
        {/* Status bar */}
        <Box marginTop={1} flexDirection="row" justifyContent="space-between">
          <Box>
            {hasContent ? (
              <Text color={theme.success}>
                ✓ {charCount} chars • {lineCount} line{lineCount !== 1 ? 's' : ''}
              </Text>
            ) : (
              <Text dimColor>○ Type to begin...</Text>
            )}
          </Box>
          <Box>
            {error ? (
              <Text color={theme.error}>⚠ {error}</Text>
            ) : (
              <Text dimColor>
                {hasContent ? 'Ready' : 'Waiting'}
              </Text>
            )}
          </Box>
        </Box>
      </Box>
      
      {/* Instructions */}
      <Box marginTop={1}>
        <Text dimColor>
          Press Enter to submit · Shift+Enter for new line
        </Text>
      </Box>
    </Box>
  )
}

// Loading spinner component
interface LoadingSpinnerProps {
  text?: string
}

function LoadingSpinner({ text }: LoadingSpinnerProps) {
  const theme = getTheme()
  const [frame, setFrame] = useState(0)
  
  useEffect(() => {
    const interval = setInterval(() => {
      setFrame(prev => (prev + 1) % UI_ICONS.loading.length)
    }, 100)
    return () => clearInterval(interval)
  }, [])
  
  return (
    <Box>
      <Text color={theme.primary}>{UI_ICONS.loading[frame]}</Text>
      {text && <Text color={theme.secondary}> {text}</Text>}
    </Box>
  )
}

// Complete agents UI with comprehensive state management
interface AgentsUIProps {
  onExit: (message?: string) => void
}

function AgentsUI({ onExit }: AgentsUIProps) {
  const theme = getTheme()
  
  // Core state management
  const [modeState, setModeState] = useState<ModeState>({
    mode: "list-agents",
    location: "all" as AgentLocation
  })
  
  const [agents, setAgents] = useState<AgentConfig[]>([])
  const [changes, setChanges] = useState<string[]>([])
  const [refreshKey, setRefreshKey] = useState(0)
  const [loading, setLoading] = useState(true)
  const [tools, setTools] = useState<Tool[]>([])
  
  // Creation state using reducer for complex flow management
  const [createState, setCreateState] = useReducer(
    (state: CreateState, action: any) => {
      switch (action.type) {
        case 'RESET':
          return {
            location: null,
            agentType: '',
            method: null,
            generationPrompt: '',
            whenToUse: '',
            selectedTools: [],
            selectedModel: null,
            selectedColor: null,
            systemPrompt: '',
            isGenerating: false,
            wasGenerated: false,
            isAIGenerated: false,
            error: null,
            warnings: [],
            agentTypeCursor: 0,
            whenToUseCursor: 0,
            promptCursor: 0,
            generationPromptCursor: 0
          }
        case 'SET_LOCATION':
          return { ...state, location: action.value }
        case 'SET_METHOD':
          return { ...state, method: action.value }
        case 'SET_AGENT_TYPE':
          return { ...state, agentType: action.value, error: null }
        case 'SET_GENERATION_PROMPT':
          return { ...state, generationPrompt: action.value }
        case 'SET_WHEN_TO_USE':
          return { ...state, whenToUse: action.value, error: null }
        case 'SET_SELECTED_TOOLS':
          return { ...state, selectedTools: action.value }
        case 'SET_SELECTED_MODEL':
          return { ...state, selectedModel: action.value }
        case 'SET_SELECTED_COLOR':
          return { ...state, selectedColor: action.value }
        case 'SET_SYSTEM_PROMPT':
          return { ...state, systemPrompt: action.value }
        case 'SET_IS_GENERATING':
          return { ...state, isGenerating: action.value }
        case 'SET_WAS_GENERATED':
          return { ...state, wasGenerated: action.value }
        case 'SET_IS_AI_GENERATED':
          return { ...state, isAIGenerated: action.value }
        case 'SET_ERROR':
          return { ...state, error: action.value }
        case 'SET_WARNINGS':
          return { ...state, warnings: action.value }
        case 'SET_CURSOR':
          return { ...state, [action.field]: action.value }
        default:
          return state
      }
    },
    {
      location: null,
      agentType: '',
      method: null,
      generationPrompt: '',
      whenToUse: '',
      selectedTools: [],
      selectedModel: null,
      selectedColor: null,
      systemPrompt: '',
      isGenerating: false,
      wasGenerated: false,
      isAIGenerated: false,
      error: null,
      warnings: [],
      agentTypeCursor: 0,
      whenToUseCursor: 0,
      promptCursor: 0,
      generationPromptCursor: 0
    }
  )
  
  // Load agents and tools dynamically
  const loadAgents = useCallback(async () => {
    setLoading(true)
    clearAgentCache()
    
    // 创建取消令牌以防止竞态条件
    const abortController = new AbortController()
    const loadingId = Date.now() // 用于标识这次加载
    
    try {
      const result = await getActiveAgents()
      
      // 检查是否仍然是当前的加载请求
      if (abortController.signal.aborted) {
        return // 组件已卸载或新的加载已开始
      }
      
      setAgents(result)
      
      // Update selectedAgent if there's one currently selected (for live reload)
      if (modeState.selectedAgent) {
        const freshSelectedAgent = result.find(a => a.agentType === modeState.selectedAgent!.agentType)
        if (freshSelectedAgent) {
          setModeState(prev => ({ ...prev, selectedAgent: freshSelectedAgent }))
        }
      }
      
      // Load available tools dynamically from tool registry
      const availableTools: Tool[] = []
      
      // Core built-in tools
      let coreTools = [
        { name: 'Read', description: 'Read files from filesystem' },
        { name: 'Write', description: 'Write files to filesystem' },
        { name: 'Edit', description: 'Edit existing files' },
        { name: 'MultiEdit', description: 'Make multiple edits to files' },
        { name: 'NotebookEdit', description: 'Edit Jupyter notebooks' },
        { name: 'Bash', description: 'Execute bash commands' },
        { name: 'Glob', description: 'Find files matching patterns' },
        { name: 'Grep', description: 'Search file contents' },
        { name: 'LS', description: 'List directory contents' },
        { name: 'WebFetch', description: 'Fetch web content' },
        { name: 'WebSearch', description: 'Search the web' },
        { name: 'TodoWrite', description: 'Manage task lists' }
      ]
      // Hide agent orchestration/self-control tools for subagent configs
      coreTools = coreTools.filter(t => t.name !== 'Task' && t.name !== 'ExitPlanMode')
      
      availableTools.push(...coreTools)
      
      // Try to load MCP tools dynamically
      try {
        const mcpTools = await getMCPTools()
        if (Array.isArray(mcpTools) && mcpTools.length > 0) {
          availableTools.push(...mcpTools)
        }
      } catch (error) {
        console.warn('Failed to load MCP tools:', error)
      }
      
      if (!abortController.signal.aborted) {
        setTools(availableTools)
      }
    } catch (error) {
      if (!abortController.signal.aborted) {
        console.error('Failed to load agents:', error)
      }
    } finally {
      if (!abortController.signal.aborted) {
        setLoading(false)
      }
    }
    
    // 返回取消函数供useEffect使用
    return () => abortController.abort()
  }, [])
  
  // Remove mock MCP loader; real MCP tools are loaded via getMCPTools()

  useEffect(() => {
    let cleanup: (() => void) | undefined
    
    const load = async () => {
      cleanup = await loadAgents()
    }
    
    load()
    
    return () => {
      if (cleanup) {
        cleanup()
      }
    }
  }, [refreshKey, loadAgents])
  
  // Local file watcher removed; rely on global watcher started in CLI.
  
  // Global keyboard handling: ESC 逐级返回
  useInput((input, key) => {
    if (!key.escape) return

    const changesSummary = changes.length > 0 ?
      `Agent changes:\n${changes.join('\n')}` : undefined

    const current = modeState.mode

    if (current === 'list-agents') {
      onExit(changesSummary)
      return
    }

    // Hierarchical back navigation
    switch (current) {
      case 'create-location':
        setModeState({ mode: 'list-agents', location: 'all' as AgentLocation })
        break
      case 'create-method':
        setModeState({ mode: 'create-location', location: modeState.location })
        break
      case 'create-generate':
        setModeState({ mode: 'create-location', location: modeState.location })
        break
      case 'create-type':
        setModeState({ mode: 'create-generate', location: modeState.location })
        break
      case 'create-prompt':
        setModeState({ mode: 'create-type', location: modeState.location })
        break
      case 'create-description':
        setModeState({ mode: 'create-prompt', location: modeState.location })
        break
      case 'create-tools':
        setModeState({ mode: 'create-description', location: modeState.location })
        break
      case 'create-model':
        setModeState({ mode: 'create-tools', location: modeState.location })
        break
      case 'create-color':
        setModeState({ mode: 'create-model', location: modeState.location })
        break
      case 'create-confirm':
        setModeState({ mode: 'create-color', location: modeState.location })
        break
      case 'agent-menu':
        setModeState({ mode: 'list-agents', location: 'all' as AgentLocation })
        break
      case 'view-agent':
        setModeState({ mode: 'agent-menu', selectedAgent: modeState.selectedAgent })
        break
      case 'edit-agent':
        setModeState({ mode: 'agent-menu', selectedAgent: modeState.selectedAgent })
        break
      case 'edit-tools':
      case 'edit-model':
      case 'edit-color':
        setModeState({ mode: 'edit-agent', selectedAgent: modeState.selectedAgent })
        break
      case 'delete-confirm':
        setModeState({ mode: 'agent-menu', selectedAgent: modeState.selectedAgent })
        break
      default:
        setModeState({ mode: 'list-agents', location: 'all' as AgentLocation })
        break
    }
  })
  
  // Event handlers
  const handleAgentSelect = useCallback((agent: AgentConfig) => {
    setModeState({ 
      mode: "agent-menu", 
      location: modeState.location,
      selectedAgent: agent
    })
  }, [modeState])

  const handleCreateNew = useCallback(() => {
    console.log('=== STARTING AGENT CREATION FLOW ===')
    console.log('Current mode state:', modeState)
    setCreateState({ type: 'RESET' })
    console.log('Reset create state')
    setModeState({ mode: "create-location" })
    console.log('Set mode to create-location')
    console.log('=== CREATE NEW HANDLER COMPLETED ===')
  }, [modeState])

  const handleAgentCreated = useCallback((message: string) => {
    setChanges(prev => [...prev, message])
    setRefreshKey(prev => prev + 1)
    setModeState({ mode: "list-agents", location: "all" as AgentLocation })
  }, [])
  
  const handleAgentDeleted = useCallback((message: string) => {
    setChanges(prev => [...prev, message])
    setRefreshKey(prev => prev + 1)
    setModeState({ mode: "list-agents", location: "all" as AgentLocation })
  }, [])
  
  if (loading) {
    return (
      <Box flexDirection="column">
        <Header title="Agents">
          <Box marginTop={1}>
            <LoadingSpinner text="Loading agents..." />
          </Box>
        </Header>
        <InstructionBar />
      </Box>
    )
  }

  // Render based on current mode
  switch (modeState.mode) {
    case "list-agents":
      return (
        <AgentListView
          location={modeState.location || "all"}
          agents={agents}
          allAgents={agents}
          onBack={() => onExit()}
          onSelect={handleAgentSelect}
          onCreateNew={handleCreateNew}
          changes={changes}
        />
      )

    case "create-location":
      return (
        <LocationSelect
          createState={createState}
          setCreateState={setCreateState}
          setModeState={setModeState}
        />
      )
      
    case "create-method":
      return (
        <MethodSelect
          createState={createState}
          setCreateState={setCreateState}
          setModeState={setModeState}
        />
      )
      
    case "create-generate":
      return (
        <GenerateStep
          createState={createState}
          setCreateState={setCreateState}
          setModeState={setModeState}
          existingAgents={agents}
        />
      )
      
    case "create-type":
      return (
        <TypeStep
          createState={createState}
          setCreateState={setCreateState}
          setModeState={setModeState}
          existingAgents={agents}
        />
      )
      
    case "create-description":
      return (
        <DescriptionStep
          createState={createState}
          setCreateState={setCreateState}
          setModeState={setModeState}
        />
      )
      
    case "create-tools":
      return (
        <ToolsStep
          createState={createState}
          setCreateState={setCreateState}
          setModeState={setModeState}
          tools={tools}
        />
      )
      
    case "create-model":
      return (
        <ModelStep
          createState={createState}
          setCreateState={setCreateState}
          setModeState={setModeState}
        />
      )
      
    case "create-color":
      return (
        <ColorStep
          createState={createState}
          setCreateState={setCreateState}
          setModeState={setModeState}
        />
      )
      
    case "create-prompt":
      return (
        <PromptStep
          createState={createState}
          setCreateState={setCreateState}
          setModeState={setModeState}
        />
      )
      
    case "create-confirm":
      return (
        <ConfirmStep
          createState={createState}
          setCreateState={setCreateState}
          setModeState={setModeState}
          tools={tools}
          onAgentCreated={handleAgentCreated}
        />
      )
      
    case "agent-menu":
      return (
        <AgentMenu
          agent={modeState.selectedAgent!}
          setModeState={setModeState}
        />
      )
      
    case "view-agent":
      return (
        <ViewAgent
          agent={modeState.selectedAgent!}
          tools={tools}
          setModeState={setModeState}
        />
      )
      
    case "edit-agent":
      return (
        <EditMenu
          agent={modeState.selectedAgent!}
          setModeState={setModeState}
        />
      )
      
    case "edit-tools":
      return (
        <EditToolsStep
          agent={modeState.selectedAgent!}
          tools={tools}
          setModeState={setModeState}
          onAgentUpdated={(message, updated) => {
            setChanges(prev => [...prev, message])
            setRefreshKey(prev => prev + 1)
            setModeState({ mode: "agent-menu", selectedAgent: updated })
          }}
        />
      )
      
    case "edit-model":
      return (
        <EditModelStep
          agent={modeState.selectedAgent!}
          setModeState={setModeState}
          onAgentUpdated={(message, updated) => {
            setChanges(prev => [...prev, message])
            setRefreshKey(prev => prev + 1)
            setModeState({ mode: "agent-menu", selectedAgent: updated })
          }}
        />
      )
      
    case "edit-color":
      return (
        <EditColorStep
          agent={modeState.selectedAgent!}
          setModeState={setModeState}
          onAgentUpdated={(message, updated) => {
            setChanges(prev => [...prev, message])
            setRefreshKey(prev => prev + 1)
            setModeState({ mode: "agent-menu", selectedAgent: updated })
          }}
        />
      )
      
    case "delete-confirm":
      return (
        <DeleteConfirm
          agent={modeState.selectedAgent!}
          setModeState={setModeState}
          onAgentDeleted={handleAgentDeleted}
        />
      )
      
    default:
      return (
        <Box flexDirection="column">
          <Header title="Agents">
            <Text>Mode: {modeState.mode} (Not implemented yet)</Text>
            <Box marginTop={1}>
              <Text>Press Esc to go back</Text>
            </Box>
          </Header>
          <InstructionBar instructions="Esc to go back" />
        </Box>
      )
  }
}

interface AgentListProps {
  location: AgentLocation
  agents: AgentConfig[]
  allAgents: AgentConfig[]
  onBack: () => void
  onSelect: (agent: AgentConfig) => void
  onCreateNew?: () => void
  changes: string[]
}

function AgentListView({ 
  location, 
  agents, 
  allAgents, 
  onBack, 
  onSelect, 
  onCreateNew, 
  changes 
}: AgentListProps) {
  const theme = getTheme()
  const allAgentsList = allAgents || agents
  const customAgents = allAgentsList.filter(a => a.location !== "built-in")
  const builtInAgents = allAgentsList.filter(a => a.location === "built-in")

  const [selectedAgent, setSelectedAgent] = useState<AgentConfig | null>(null)
  const [onCreateOption, setOnCreateOption] = useState(true)
  const [currentLocation, setCurrentLocation] = useState<AgentLocation>(location)
  const [inLocationTabs, setInLocationTabs] = useState(false)
  const [selectedLocationTab, setSelectedLocationTab] = useState(0)
  
  const locationTabs = [
    { label: "All", value: "all" as AgentLocation },
    { label: "Personal", value: "user" as AgentLocation },
    { label: "Project", value: "project" as AgentLocation }
  ]

  const activeMap = useMemo(() => {
    const map = new Map<string, AgentConfig>()
    agents.forEach(a => map.set(a.agentType, a))
    return map
  }, [agents])

  const checkOverride = (agent: AgentConfig) => {
    const active = activeMap.get(agent.agentType)
    const isOverridden = !!(active && active.location !== agent.location)
    return {
      isOverridden,
      overriddenBy: isOverridden ? active.location : null
    }
  }

  const renderCreateOption = () => (
    <Box flexDirection="row" gap={1}>
      <Text color={onCreateOption ? theme.primary : undefined}>
        {onCreateOption ? `${UI_ICONS.pointer} ` : "  "}
      </Text>
      <Text bold color={onCreateOption ? theme.primary : undefined}>
        ✨ Create new agent
      </Text>
    </Box>
  )

  const renderAgent = (agent: AgentConfig, isBuiltIn = false) => {
    const isSelected = !isBuiltIn && !onCreateOption && 
                      selectedAgent?.agentType === agent.agentType &&
                      selectedAgent?.location === agent.location
    const { isOverridden, overriddenBy } = checkOverride(agent)
    const dimmed = isBuiltIn || isOverridden
    const color = !isBuiltIn && isSelected ? theme.primary : undefined
    
    // Extract model from agent metadata
    const agentModel = (agent as any).model || null
    const modelDisplay = getDisplayModelName(agentModel)

    return (
      <Box key={`${agent.agentType}-${agent.location}`} flexDirection="row" alignItems="center">
        <Box flexDirection="row" alignItems="center" minWidth={3}>
          <Text dimColor={dimmed && !isSelected} color={color}>
            {isBuiltIn ? "" : isSelected ? `${UI_ICONS.pointer} ` : "  "}
          </Text>
        </Box>
        <Box flexDirection="row" alignItems="center" flexGrow={1}>
          <Text dimColor={dimmed && !isSelected} color={color}>
            {agent.agentType}
          </Text>
          <Text dimColor={true} color={dimmed ? undefined : 'gray'}>
            {" · "}{modelDisplay}
          </Text>
        </Box>
        {overriddenBy && (
          <Box marginLeft={1}>
            <Text dimColor={!isSelected} color={isSelected ? 'yellow' : 'gray'}>
              {UI_ICONS.warning} overridden by {overriddenBy}
            </Text>
          </Box>
        )}
      </Box>
    )
  }

  const displayAgents = useMemo(() => {
    if (currentLocation === "all") {
      return [
        ...customAgents.filter(a => a.location === "user"),
        ...customAgents.filter(a => a.location === "project")
      ]
    } else if (currentLocation === "user" || currentLocation === "project") {
      return customAgents.filter(a => a.location === currentLocation)
    }
    return customAgents
  }, [customAgents, currentLocation])
  
  // 更新当前选中的标签索引
  useEffect(() => {
    const tabIndex = locationTabs.findIndex(tab => tab.value === currentLocation)
    if (tabIndex !== -1) {
      setSelectedLocationTab(tabIndex)
    }
  }, [currentLocation, locationTabs])
  
  // 确保当有agents时，初始化选择状态
  useEffect(() => {
    if (displayAgents.length > 0 && !selectedAgent && !onCreateOption) {
      setOnCreateOption(true) // 默认选择创建选项
    }
  }, [displayAgents.length, selectedAgent, onCreateOption])

  useInput((input, key) => {
    if (key.escape) {
      if (inLocationTabs) {
        setInLocationTabs(false)
        return
      }
      onBack()
      return
    }

    if (key.return) {
      if (inLocationTabs) {
        setCurrentLocation(locationTabs[selectedLocationTab].value)
        setInLocationTabs(false)
        return
      }
      if (onCreateOption && onCreateNew) {
        onCreateNew()
      } else if (selectedAgent) {
        onSelect(selectedAgent)
      }
      return
    }
    
    // Tab键进入/退出标签导航
    if (key.tab) {
      setInLocationTabs(!inLocationTabs)
      return
    }
    
    // 在标签导航模式
    if (inLocationTabs) {
      if (key.leftArrow) {
        setSelectedLocationTab(prev => prev > 0 ? prev - 1 : locationTabs.length - 1)
      } else if (key.rightArrow) {
        setSelectedLocationTab(prev => prev < locationTabs.length - 1 ? prev + 1 : 0)
      }
      return
    }
    
    // 键盘导航 - 这是关键缺失的功能
    if (key.upArrow || key.downArrow) {
      const allNavigableItems = []
      
      // 添加创建选项
      if (onCreateNew) {
        allNavigableItems.push({ type: 'create', agent: null })
      }
      
      // 添加可导航的agents
      displayAgents.forEach(agent => {
        const { isOverridden } = checkOverride(agent)
        if (!isOverridden) { // 只显示未被覆盖的agents
          allNavigableItems.push({ type: 'agent', agent })
        }
      })
      
      if (allNavigableItems.length === 0) return
      
      if (key.upArrow) {
        if (onCreateOption) {
          // 从创建选项向上到最后一个agent
          const lastAgent = allNavigableItems[allNavigableItems.length - 1]
          if (lastAgent.type === 'agent') {
            setSelectedAgent(lastAgent.agent)
            setOnCreateOption(false)
          }
        } else if (selectedAgent) {
          const currentIndex = allNavigableItems.findIndex(
            item => item.type === 'agent' && 
                   item.agent?.agentType === selectedAgent.agentType &&
                   item.agent?.location === selectedAgent.location
          )
          if (currentIndex > 0) {
            const prevItem = allNavigableItems[currentIndex - 1]
            if (prevItem.type === 'create') {
              setOnCreateOption(true)
              setSelectedAgent(null)
            } else {
              setSelectedAgent(prevItem.agent)
            }
          } else {
            // 到达顶部，回到创建选项
            if (onCreateNew) {
              setOnCreateOption(true)
              setSelectedAgent(null)
            }
          }
        }
      } else if (key.downArrow) {
        if (onCreateOption) {
          // 从创建选项向下到第一个agent
          const firstAgent = allNavigableItems.find(item => item.type === 'agent')
          if (firstAgent) {
            setSelectedAgent(firstAgent.agent)
            setOnCreateOption(false)
          }
        } else if (selectedAgent) {
          const currentIndex = allNavigableItems.findIndex(
            item => item.type === 'agent' && 
                   item.agent?.agentType === selectedAgent.agentType &&
                   item.agent?.location === selectedAgent.location
          )
          if (currentIndex < allNavigableItems.length - 1) {
            const nextItem = allNavigableItems[currentIndex + 1]
            if (nextItem.type === 'agent') {
              setSelectedAgent(nextItem.agent)
            }
          } else {
            // 到达底部，回到创建选项
            if (onCreateNew) {
              setOnCreateOption(true)
              setSelectedAgent(null)
            }
          }
        }
      }
    }
  })

  // 特殊的键盘输入处理组件用于空状态
  const EmptyStateInput = () => {
    useInput((input, key) => {
      if (key.escape) {
        onBack()
        return
      }
      if (key.return && onCreateNew) {
        onCreateNew()
        return
      }
    })
    return null
  }

  if (!agents.length || (currentLocation !== "built-in" && !customAgents.length)) {
    return (
      <Box flexDirection="column">
        <EmptyStateInput />
        <Header title="🤖 Agents" subtitle="">
          {onCreateNew && (
            <Box marginY={1}>
              {renderCreateOption()}
            </Box>
          )}
          <Box marginTop={1} flexDirection="column">
            <Box marginBottom={1}>
              <Text bold color={theme.primary}>💭 What are agents?</Text>
            </Box>
            <Text>Specialized AI assistants that Claude can delegate to for specific tasks.</Text>
            <Text>Each agent has its own context, prompt, and tools.</Text>
            
            <Box marginTop={1} marginBottom={1}>
              <Text bold color={theme.primary}>💡 Popular agent ideas:</Text>
            </Box>
            <Box paddingLeft={2} flexDirection="column">
              <Text>• 🔍 Code Reviewer - Reviews PRs for best practices</Text>
              <Text>• 🔒 Security Auditor - Finds vulnerabilities</Text>
              <Text>• ⚡ Performance Optimizer - Improves code speed</Text>
              <Text>• 🧑‍💼 Tech Lead - Makes architecture decisions</Text>
              <Text>• 🎨 UX Expert - Improves user experience</Text>
            </Box>
          </Box>

          {currentLocation !== "built-in" && builtInAgents.length > 0 && (
            <>
              <Box marginTop={1}><Text>{UI_ICONS.separator.repeat(40)}</Text></Box>
              <Box flexDirection="column" marginBottom={1} paddingLeft={2}>
                <Text bold color={theme.secondary}>Built-in (always available):</Text>
                {builtInAgents.map(a => renderAgent(a, true))}
              </Box>
            </>
          )}
        </Header>
        <InstructionBar instructions="Press Enter to create new agent · Esc to go back" />
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Header title="🤖 Agents" subtitle="">
        {changes.length > 0 && (
          <Box marginTop={1}>
            <Text dimColor>{changes[changes.length - 1]}</Text>
          </Box>
        )}

        {/* Fancy location tabs */}
        <Box marginTop={1} flexDirection="column">
          <Box flexDirection="row" gap={2}>
            {locationTabs.map((tab, idx) => {
              const isActive = currentLocation === tab.value
              const isSelected = inLocationTabs && idx === selectedLocationTab
              return (
                <Box key={tab.value} flexDirection="row">
                  <Text 
                    color={isSelected || isActive ? theme.primary : undefined}
                    bold={isActive}
                    dimColor={!isActive && !isSelected}
                  >
                    {isSelected ? '▶ ' : isActive ? '◉ ' : '○ '}
                    {tab.label}
                  </Text>
                  {idx < locationTabs.length - 1 && <Text dimColor> | </Text>}
                </Box>
              )
            })}
          </Box>
          <Box marginTop={0}>
            <Text dimColor>
              {currentLocation === 'all' ? 'Showing all agents' : 
               currentLocation === 'user' ? 'Personal agents (~/.claude/agents)' : 
               'Project agents (.claude/agents)'}
            </Text>
          </Box>
        </Box>

        <Box flexDirection="column" marginTop={1}>
          {onCreateNew && (
            <Box marginBottom={1}>
              {renderCreateOption()}
            </Box>
          )}

          {currentLocation === "all" ? (
            <>
              {customAgents.filter(a => a.location === "user").length > 0 && (
                <>
                  <Text bold color={theme.secondary}>Personal:</Text>
                  {customAgents.filter(a => a.location === "user").map(a => renderAgent(a))}
                </>
              )}
              
              {customAgents.filter(a => a.location === "project").length > 0 && (
                <>
                  <Box marginTop={customAgents.filter(a => a.location === "user").length > 0 ? 1 : 0}>
                    <Text bold color={theme.secondary}>Project:</Text>
                  </Box>
                  {customAgents.filter(a => a.location === "project").map(a => renderAgent(a))}
                </>
              )}
              
              {builtInAgents.length > 0 && (
                <>
                  <Box marginTop={customAgents.length > 0 ? 1 : 0}>
                    <Text>{UI_ICONS.separator.repeat(40)}</Text>
                  </Box>
                  <Box flexDirection="column">
                    <Text bold color={theme.secondary}>Built-in:</Text>
                    {builtInAgents.map(a => renderAgent(a, true))}
                  </Box>
                </>
              )}
            </>
          ) : (
            <>
              {displayAgents.map(a => renderAgent(a))}
              {currentLocation !== "built-in" && builtInAgents.length > 0 && (
                <>
                  <Box marginTop={1}><Text>{UI_ICONS.separator.repeat(40)}</Text></Box>
                  <Box flexDirection="column">
                    <Text bold color={theme.secondary}>Built-in:</Text>
                    {builtInAgents.map(a => renderAgent(a, true))}
                  </Box>
                </>
              )}
            </>
          )}
        </Box>
      </Header>
      <InstructionBar 
        instructions={inLocationTabs ? 
          "←→ Switch tabs • Enter Select • Tab Exit tabs" :
          "↑↓ Navigate • Tab Location • Enter Select"
        }
      />
    </Box>
  )
}

// Common interface for creation step props
interface StepProps {
  createState: CreateState
  setCreateState: React.Dispatch<any>
  setModeState: (state: ModeState) => void
}

// Step 3: AI Generation
interface GenerateStepProps extends StepProps {
  existingAgents: AgentConfig[]
}

function GenerateStep({ createState, setCreateState, setModeState, existingAgents }: GenerateStepProps) {
  const handleSubmit = async () => {
    if (createState.generationPrompt.trim()) {
      setCreateState({ type: 'SET_IS_GENERATING', value: true })
      setCreateState({ type: 'SET_ERROR', value: null })
      
      try {
        const generated = await generateAgentWithClaude(createState.generationPrompt)
        
        // Validate the generated identifier doesn't conflict
        const validation = validateAgentType(generated.identifier, existingAgents)
        let finalIdentifier = generated.identifier
        
        if (!validation.isValid) {
          // Add a suffix to make it unique
          let counter = 1
          while (true) {
            const testId = `${generated.identifier}-${counter}`
            const testValidation = validateAgentType(testId, existingAgents)
            if (testValidation.isValid) {
              finalIdentifier = testId
              break
            }
            counter++
            if (counter > 10) {
              finalIdentifier = `custom-agent-${Date.now()}`
              break
            }
          }
        }
        
        setCreateState({ type: 'SET_AGENT_TYPE', value: finalIdentifier })
        setCreateState({ type: 'SET_WHEN_TO_USE', value: generated.whenToUse })
        setCreateState({ type: 'SET_SYSTEM_PROMPT', value: generated.systemPrompt })
        setCreateState({ type: 'SET_WAS_GENERATED', value: true })
        setCreateState({ type: 'SET_IS_GENERATING', value: false })
        setModeState({ mode: 'create-tools', location: createState.location })
      } catch (error) {
        console.error('Generation failed:', error)
        setCreateState({ type: 'SET_ERROR', value: 'Failed to generate agent. Please try again or use manual configuration.' })
        setCreateState({ type: 'SET_IS_GENERATING', value: false })
      }
    }
  }
  
  return (
    <Box flexDirection="column">
      <Header title="✨ New Agent" subtitle="What should it do?" step={2} totalSteps={8}>
        <Box marginTop={1}>
          {createState.isGenerating ? (
            <Box flexDirection="column">
              <Text dimColor>{createState.generationPrompt}</Text>
              <Box marginTop={1}>
                <LoadingSpinner text="Generating agent configuration..." />
              </Box>
            </Box>
          ) : (
            <MultilineTextInput
              value={createState.generationPrompt}
              onChange={(value) => setCreateState({ type: 'SET_GENERATION_PROMPT', value })}
              placeholder="An expert that reviews pull requests for best practices, security issues, and suggests improvements..."
              onSubmit={handleSubmit}
              error={createState.error}
              rows={3}
            />
          )}
        </Box>
      </Header>
      <InstructionBar />
    </Box>
  )
}

// Step 4: Manual type input (for manual method)
interface TypeStepProps extends StepProps {
  existingAgents: AgentConfig[]
}

function TypeStep({ createState, setCreateState, setModeState, existingAgents }: TypeStepProps) {
  const handleSubmit = () => {
    const validation = validateAgentType(createState.agentType, existingAgents)
    if (validation.isValid) {
      setModeState({ mode: 'create-prompt', location: createState.location })
    } else {
      setCreateState({ type: 'SET_ERROR', value: validation.errors[0] })
    }
  }
  
  return (
    <Box flexDirection="column">
      <Header title="Create new agent" subtitle="Enter agent identifier" step={3} totalSteps={8}>
        <Box marginTop={1}>
          <InkTextInput
            value={createState.agentType}
            onChange={(value) => setCreateState({ type: 'SET_AGENT_TYPE', value })}
            placeholder="e.g. code-reviewer, tech-lead"
            onSubmit={handleSubmit}
          />
          {createState.error && (
            <Box marginTop={1}>
              <Text color="red">⚠ {createState.error}</Text>
            </Box>
          )}
        </Box>
      </Header>
      <InstructionBar />
    </Box>
  )
}

// Step 5: Description input
function DescriptionStep({ createState, setCreateState, setModeState }: StepProps) {
  const handleSubmit = () => {
    if (createState.whenToUse.trim()) {
      setModeState({ mode: 'create-tools', location: createState.location })
    }
  }
  
  return (
    <Box flexDirection="column">
      <Header title="Create new agent" subtitle="Describe when to use this agent" step={5} totalSteps={8}>
        <Box marginTop={1}>
          <MultilineTextInput
            value={createState.whenToUse}
            onChange={(value) => setCreateState({ type: 'SET_WHEN_TO_USE', value })}
            placeholder="Use this agent when you need to review code for best practices, security issues..."
            onSubmit={handleSubmit}
            error={createState.error}
            rows={4}
          />
        </Box>
      </Header>
      <InstructionBar />
    </Box>
  )
}

// Step 6: Tools selection
interface ToolsStepProps extends StepProps {
  tools: Tool[]
}

function ToolsStep({ createState, setCreateState, setModeState, tools }: ToolsStepProps) {
  const [selectedIndex, setSelectedIndex] = useState(0)
  // Default to all tools selected initially
  const initialSelection = createState.selectedTools.length > 0 ? 
    new Set(createState.selectedTools) : 
    new Set(tools.map(t => t.name))  // Select all tools by default
  const [selectedTools, setSelectedTools] = useState<Set<string>>(initialSelection)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [selectedCategory, setSelectedCategory] = useState<keyof typeof TOOL_CATEGORIES | 'mcp' | 'all'>('all')
  
  // Categorize tools
  const categorizedTools = useMemo(() => {
    const categories: Record<string, Tool[]> = {
      read: [],
      edit: [],
      execution: [],
      web: [],
      mcp: [],
      other: []
    }
    
    tools.forEach(tool => {
      let categorized = false
      
      // Check MCP tools first
      if (tool.name.startsWith('mcp__')) {
        categories.mcp.push(tool)
        categorized = true
      } else {
        // Check built-in categories
        for (const [category, toolNames] of Object.entries(TOOL_CATEGORIES)) {
          if (Array.isArray(toolNames) && toolNames.includes(tool.name)) {
            categories[category as keyof typeof categories]?.push(tool)
            categorized = true
            break
          }
        }
      }
      
      if (!categorized) {
        categories.other.push(tool)
      }
    })
    
    return categories
  }, [tools])
  
  const displayTools = useMemo(() => {
    if (selectedCategory === 'all') {
      return tools
    }
    return categorizedTools[selectedCategory] || []
  }, [selectedCategory, tools, categorizedTools])
  
  const allSelected = selectedTools.size === tools.length && tools.length > 0
  const categoryOptions = [
    { id: 'all', label: `All (${tools.length})` },
    { id: 'read', label: `Read (${categorizedTools.read.length})` },
    { id: 'edit', label: `Edit (${categorizedTools.edit.length})` },
    { id: 'execution', label: `Execution (${categorizedTools.execution.length})` },
    { id: 'web', label: `Web (${categorizedTools.web.length})` },
    { id: 'mcp', label: `MCP (${categorizedTools.mcp.length})` },
    { id: 'other', label: `Other (${categorizedTools.other.length})` }
  ].filter(cat => cat.id === 'all' || categorizedTools[cat.id]?.length > 0)
  
  // Calculate category selections
  const readSelected = categorizedTools.read.every(tool => selectedTools.has(tool.name))
  const editSelected = categorizedTools.edit.every(tool => selectedTools.has(tool.name))
  const execSelected = categorizedTools.execution.every(tool => selectedTools.has(tool.name))
  const webSelected = categorizedTools.web.every(tool => selectedTools.has(tool.name))
  
  const options: Array<{
    id: string
    label: string
    isContinue?: boolean
    isAll?: boolean
    isTool?: boolean
    isCategory?: boolean
    isAdvancedToggle?: boolean
    isSeparator?: boolean
  }> = [
    { id: 'continue', label: 'Save', isContinue: true },
    { id: 'separator1', label: '────────────────────────────────────', isSeparator: true },
    { id: 'all', label: `${allSelected ? UI_ICONS.checkboxOn : UI_ICONS.checkboxOff} All tools`, isAll: true },
    { id: 'read', label: `${readSelected ? UI_ICONS.checkboxOn : UI_ICONS.checkboxOff} Read-only tools`, isCategory: true },
    { id: 'edit', label: `${editSelected ? UI_ICONS.checkboxOn : UI_ICONS.checkboxOff} Edit tools`, isCategory: true },
    { id: 'execution', label: `${execSelected ? UI_ICONS.checkboxOn : UI_ICONS.checkboxOff} Execution tools`, isCategory: true },
    { id: 'separator2', label: '────────────────────────────────────', isSeparator: true },
    { id: 'advanced', label: `[ ${showAdvanced ? 'Hide' : 'Show'} advanced options ]`, isAdvancedToggle: true },
    ...(showAdvanced ? displayTools.map(tool => ({
      id: tool.name,
      label: `${selectedTools.has(tool.name) ? UI_ICONS.checkboxOn : UI_ICONS.checkboxOff} ${tool.name}`,
      isTool: true
    })) : [])
  ]
  
  const handleSelect = () => {
    const option = options[selectedIndex] as any // Type assertion for union type
    if (!option) return
    if (option.isSeparator) return
    
    if (option.isContinue) {
      const result = allSelected ? ['*'] : Array.from(selectedTools)
      setCreateState({ type: 'SET_SELECTED_TOOLS', value: result })
      setModeState({ mode: 'create-model', location: createState.location })
    } else if (option.isAdvancedToggle) {
      setShowAdvanced(!showAdvanced)
    } else if (option.isAll) {
      if (allSelected) {
        setSelectedTools(new Set())
      } else {
        setSelectedTools(new Set(tools.map(t => t.name)))
      }
    } else if (option.isCategory) {
      const categoryName = option.id as keyof typeof categorizedTools
      const categoryTools = categorizedTools[categoryName] || []
      const newSelected = new Set(selectedTools)
      
      const categorySelected = categoryTools.every(tool => selectedTools.has(tool.name))
      if (categorySelected) {
        // Unselect all tools in this category
        categoryTools.forEach(tool => newSelected.delete(tool.name))
      } else {
        // Select all tools in this category
        categoryTools.forEach(tool => newSelected.add(tool.name))
      }
      setSelectedTools(newSelected)
    } else if (option.isTool) {
      const newSelected = new Set(selectedTools)
      if (newSelected.has(option.id)) {
        newSelected.delete(option.id)
      } else {
        newSelected.add(option.id)
      }
      setSelectedTools(newSelected)
    }
  }
  
  useInput((input, key) => {
    if (key.return) {
      handleSelect()
    } else if (key.upArrow) {
      setSelectedIndex(prev => {
        let newIndex = prev > 0 ? prev - 1 : options.length - 1
        // Skip separators when going up
        while (options[newIndex] && (options[newIndex] as any).isSeparator) {
          newIndex = newIndex > 0 ? newIndex - 1 : options.length - 1
        }
        return newIndex
      })
    } else if (key.downArrow) {
      setSelectedIndex(prev => {
        let newIndex = prev < options.length - 1 ? prev + 1 : 0
        // Skip separators when going down
        while (options[newIndex] && (options[newIndex] as any).isSeparator) {
          newIndex = newIndex < options.length - 1 ? newIndex + 1 : 0
        }
        return newIndex
      })
    }
  })
  
  return (
    <Box flexDirection="column">
      <Header title="🔧 Tool Permissions" subtitle="" step={3} totalSteps={5}>
        <Box flexDirection="column" marginTop={1}>
          {options.map((option, idx) => {
            const isSelected = idx === selectedIndex
            const isContinue = option.isContinue
            const isAdvancedToggle = option.isAdvancedToggle
            const isSeparator = option.isSeparator
            
            return (
              <Box key={option.id}>
                <Text 
                  color={isSelected && !isSeparator ? 'cyan' : isSeparator ? 'gray' : undefined}
                  bold={isContinue}
                  dimColor={isSeparator}
                >
                  {isSeparator ? 
                    option.label : 
                    `${isSelected ? `${UI_ICONS.pointer} ` : '  '}${isContinue || isAdvancedToggle ? `${option.label}` : option.label}`
                  }
                </Text>
                {option.isTool && isSelected && tools.find(t => t.name === option.id)?.description && (
                  <Box marginLeft={4}>
                    <Text dimColor>{tools.find(t => t.name === option.id)?.description}</Text>
                  </Box>
                )}
              </Box>
            )
          })}
          
          <Box marginTop={1}>
            <Text dimColor>
              {allSelected ? 
                'All tools selected' : 
                `${selectedTools.size} of ${tools.length} tools selected`}
            </Text>
            {selectedCategory !== 'all' && (
              <Text dimColor>Filtering: {selectedCategory} tools</Text>
            )}
          </Box>
        </Box>
      </Header>
      <InstructionBar instructions="↑↓ Navigate • Enter Toggle • Esc Back" />
    </Box>
  )
}

// Step 6: Model selection (clean design like /models)
function ModelStep({ createState, setCreateState, setModeState }: StepProps) {
  const theme = getTheme()
  const manager = getModelManager()
  const profiles = manager.getActiveModelProfiles()
  
  // Group models by provider
  const groupedModels = profiles.reduce((acc: any, profile: any) => {
    const provider = profile.provider || 'Default'
    if (!acc[provider]) acc[provider] = []
    acc[provider].push(profile)
    return acc
  }, {})
  
  // Flatten with inherit option
  const modelOptions = [
    { id: null, name: '◈ Inherit from parent', provider: 'System', modelName: 'default' },
    ...Object.entries(groupedModels).flatMap(([provider, models]: any) => 
      models.map((p: any) => ({
        id: p.modelName,
        name: p.name,
        provider: provider,
        modelName: p.modelName
      }))
    )
  ]

  const [selectedIndex, setSelectedIndex] = useState(() => {
    const idx = modelOptions.findIndex(m => m.id === createState.selectedModel)
    return idx >= 0 ? idx : 0
  })

  const handleSelect = (modelId: string | null) => {
    setCreateState({ type: 'SET_SELECTED_MODEL', value: modelId })
    setModeState({ mode: 'create-color', location: createState.location })
  }

  useInput((input, key) => {
    if (key.return) {
      handleSelect(modelOptions[selectedIndex].id)
    } else if (key.upArrow) {
      setSelectedIndex(prev => (prev > 0 ? prev - 1 : modelOptions.length - 1))
    } else if (key.downArrow) {
      setSelectedIndex(prev => (prev < modelOptions.length - 1 ? prev + 1 : 0))
    }
  })

  return (
    <Box flexDirection="column">
      <Header title="🤖 Select Model" subtitle="" step={4} totalSteps={5}>
        <Box marginTop={1} flexDirection="column">
          {modelOptions.map((model, index) => {
            const isSelected = index === selectedIndex
            const isInherit = model.id === null
            
            return (
              <Box key={model.id || 'inherit'} marginBottom={0}>
                <Box flexDirection="row" gap={1}>
                  <Text color={isSelected ? theme.primary : undefined}>
                    {isSelected ? UI_ICONS.pointer : ' '}
                  </Text>
                  <Box flexDirection="column" flexGrow={1}>
                    <Box flexDirection="row" gap={1}>
                      <Text 
                        bold={isInherit}
                        color={isSelected ? theme.primary : undefined}
                      >
                        {model.name}
                      </Text>
                      {!isInherit && (
                        <Text dimColor>
                          {model.provider} • {model.modelName}
                        </Text>
                      )}
                    </Box>
                  </Box>
                </Box>
              </Box>
            )
          })}
        </Box>
      </Header>
      <InstructionBar instructions="↑↓ Navigate • Enter Select" />
    </Box>
  )
}

// Step 7: Color selection (using hex colors for display)
function ColorStep({ createState, setCreateState, setModeState }: StepProps) {
  const theme = getTheme()
  const [selectedIndex, setSelectedIndex] = useState(0)
  
  // Color options without red/green due to display issues
  const colors = [
    { label: 'Default', value: null, displayColor: null },
    { label: 'Yellow', value: 'yellow', displayColor: 'yellow' },
    { label: 'Blue', value: 'blue', displayColor: 'blue' },
    { label: 'Magenta', value: 'magenta', displayColor: 'magenta' },
    { label: 'Cyan', value: 'cyan', displayColor: 'cyan' },
    { label: 'Gray', value: 'gray', displayColor: 'gray' },
    { label: 'White', value: 'white', displayColor: 'white' }
  ]
  
  const handleSelect = (value: string | null) => {
    setCreateState({ type: 'SET_SELECTED_COLOR', value: value })
    setModeState({ mode: 'create-confirm', location: createState.location })
  }
  
  useInput((input, key) => {
    if (key.return) {
      handleSelect(colors[selectedIndex].value)
    } else if (key.upArrow) {
      setSelectedIndex(prev => prev > 0 ? prev - 1 : colors.length - 1)
    } else if (key.downArrow) {
      setSelectedIndex(prev => prev < colors.length - 1 ? prev + 1 : 0)
    }
  })
  
  return (
    <Box flexDirection="column">
      <Header title="🎨 Color Theme" subtitle="" step={5} totalSteps={5}>
        <Box marginTop={1} flexDirection="column">
          <Box marginBottom={1}>
            <Text dimColor>Choose how your agent appears in the list:</Text>
          </Box>
          {colors.map((color, idx) => {
            const isSelected = idx === selectedIndex
            return (
              <Box key={idx} flexDirection="row">
                <Text color={isSelected ? theme.primary : undefined}>
                  {isSelected ? '❯ ' : '  '}
                </Text>
                <Box minWidth={12}>
                  <Text bold={isSelected} color={color.displayColor || undefined}>
                    {color.label}
                  </Text>
                </Box>
              </Box>
            )
          })}
          <Box marginTop={1} paddingLeft={2}>
            <Text>Preview: </Text>
            <Text bold color={colors[selectedIndex].displayColor || undefined}>
              {createState.agentType || 'your-agent'}
            </Text>
          </Box>
        </Box>
      </Header>
      <InstructionBar instructions="↑↓ Navigate • Enter Select" />
    </Box>
  )
}

// Step 8: System prompt
function PromptStep({ createState, setCreateState, setModeState }: StepProps) {
  const handleSubmit = () => {
    if (createState.systemPrompt.trim()) {
      setModeState({ mode: 'create-description', location: createState.location })
    }
  }
  
  return (
    <Box flexDirection="column">
      <Header title="Create new agent" subtitle="System prompt" step={4} totalSteps={8}>
        <Box marginTop={1}>
          <MultilineTextInput
            value={createState.systemPrompt}
            onChange={(value) => setCreateState({ type: 'SET_SYSTEM_PROMPT', value })}
            placeholder="You are a helpful assistant that specializes in..."
            onSubmit={handleSubmit}
            error={createState.error}
            rows={5}
          />
        </Box>
      </Header>
      <InstructionBar />
    </Box>
  )
}

// Step 9: Confirmation
interface ConfirmStepProps extends StepProps {
  tools: Tool[]
  onAgentCreated: (message: string) => void
}

function ConfirmStep({ createState, setCreateState, setModeState, tools, onAgentCreated }: ConfirmStepProps) {
  const [isCreating, setIsCreating] = useState(false)
  const theme = getTheme()
  
  const handleConfirm = async () => {
    setIsCreating(true)
    try {
      await saveAgent(
        createState.location!,
        createState.agentType,
        createState.whenToUse,
        createState.selectedTools,
        createState.systemPrompt,
        createState.selectedModel,
        createState.selectedColor || undefined
      )
      onAgentCreated(`Created agent: ${createState.agentType}`)
    } catch (error) {
      setCreateState({ type: 'SET_ERROR', value: (error as Error).message })
      setIsCreating(false)
    }
  }
  
  const validation = validateAgentConfig(createState)
  const toolNames = createState.selectedTools.includes('*') ? 
    'All tools' : 
    createState.selectedTools.length > 0 ? 
      createState.selectedTools.join(', ') : 
      'No tools'
  
  const handleEditInEditor = async () => {
    const filePath = createState.location === 'project' 
      ? path.join(process.cwd(), '.claude', 'agents', `${createState.agentType}.md`)
      : path.join(os.homedir(), '.claude', 'agents', `${createState.agentType}.md`)
    
    try {
      // First, save the agent file
      await saveAgent(
        createState.location!,
        createState.agentType,
        createState.whenToUse,
        createState.selectedTools,
        createState.systemPrompt,
        createState.selectedModel,
        createState.selectedColor || undefined
      )
      
      // Then open it in editor
      const command = process.platform === 'win32' ? 'start' : 
                    process.platform === 'darwin' ? 'open' : 'xdg-open'
      await execAsync(`${command} "${filePath}"`)
      onAgentCreated(`Created agent: ${createState.agentType}`)
    } catch (error) {
      setCreateState({ type: 'SET_ERROR', value: (error as Error).message })
    }
  }

  useInput((input, key) => {
    if (isCreating) return
    
    if ((key.return || input === 's') && !isCreating) {
      handleConfirm()
    } else if (input === 'e') {
      handleEditInEditor()
    } else if (key.escape) {
      setModeState({ mode: "create-color", location: createState.location! })
    }
  })
  
  return (
    <Box flexDirection="column">
      <Header title="✅ Review & Create" subtitle="">
        <Box flexDirection="column" marginTop={1}>
          <Box marginBottom={1}>
            <Text bold color={theme.primary}>📋 Configuration</Text>
          </Box>
          
          <Box flexDirection="column" gap={0}>
            <Text>• <Text bold>Agent ID:</Text> {createState.agentType}</Text>
            <Text>• <Text bold>Location:</Text> {createState.location === 'project' ? 'Project' : 'Personal'}</Text>
            <Text>• <Text bold>Tools:</Text> {toolNames.length > 50 ? toolNames.slice(0, 50) + '...' : toolNames}</Text>
            <Text>• <Text bold>Model:</Text> {getDisplayModelName(createState.selectedModel)}</Text>
            {createState.selectedColor && (
              <Text>• <Text bold>Color:</Text> <Text color={createState.selectedColor}>{createState.selectedColor}</Text></Text>
            )}
          </Box>
          
          <Box marginTop={1} marginBottom={1}>
            <Text bold color={theme.primary}>📝 Purpose</Text>
          </Box>
          <Box paddingLeft={1}>
            <Text>{createState.whenToUse}</Text>
          </Box>
          
          {validation.warnings.length > 0 && (
            <Box marginTop={1}>
              <Text><Text bold>Warnings:</Text></Text>
              {validation.warnings.map((warning, idx) => (
                <Fragment key={idx}>
                  <Text color={theme.warning}> • {warning}</Text>
                </Fragment>
              ))}
            </Box>
          )}
          
          {createState.error && (
            <Box marginTop={1}>
              <Text color={theme.error}>✗ {createState.error}</Text>
            </Box>
          )}
          
          <Box marginTop={2}>
            {isCreating ? (
              <LoadingSpinner text="Creating agent..." />
            ) : null}
          </Box>
        </Box>
      </Header>
      <InstructionBar instructions="Enter Save • E Edit • Esc Back" />
    </Box>
  )
}

// Step 1: Location selection
interface LocationSelectProps {
  createState: CreateState
  setCreateState: React.Dispatch<any>
  setModeState: (state: ModeState) => void
}

function LocationSelect({ createState, setCreateState, setModeState }: LocationSelectProps) {
  const theme = getTheme()
  const [selectedIndex, setSelectedIndex] = useState(0)
  
  const options = [
    { label: "📁 Project", value: "project", desc: ".claude/agents/" },
    { label: "🏠 Personal", value: "user", desc: "~/.claude/agents/" }
  ]

  const handleChange = (value: string) => {
    setCreateState({ type: 'SET_LOCATION', value: value as AgentLocation })
    setCreateState({ type: 'SET_METHOD', value: 'generate' }) // Always use generate method
    setModeState({ mode: "create-generate", location: value as AgentLocation })
  }

  const handleCancel = () => {
    setModeState({ mode: "list-agents", location: "all" as AgentLocation })
  }

  useInput((input, key) => {
    if (key.escape) {
      handleCancel()
    } else if (key.return) {
      handleChange(options[selectedIndex].value)
    } else if (key.upArrow) {
      setSelectedIndex(prev => prev > 0 ? prev - 1 : options.length - 1)
    } else if (key.downArrow) {
      setSelectedIndex(prev => prev < options.length - 1 ? prev + 1 : 0)
    }
  })

  return (
    <Box flexDirection="column">
      <Header title="📦 Save Location" subtitle="" step={1} totalSteps={5}>
        <Box marginTop={1} flexDirection="column">
          {options.map((opt, idx) => (
            <Box key={opt.value} flexDirection="column" marginBottom={1}>
              <Text color={idx === selectedIndex ? theme.primary : undefined}>
                {idx === selectedIndex ? '❯ ' : '  '}{opt.label}
              </Text>
              <Box marginLeft={3}>
                <Text dimColor>{opt.desc}</Text>
              </Box>
            </Box>
          ))}
        </Box>
      </Header>
      <InstructionBar instructions="↑↓ Navigate • Enter Select" />
    </Box>
  )
}

// Step 2: Method selection
interface MethodSelectProps {
  createState: CreateState
  setCreateState: React.Dispatch<any>
  setModeState: (state: ModeState) => void
}

function MethodSelect({ createState, setCreateState, setModeState }: MethodSelectProps) {
  const [selectedIndex, setSelectedIndex] = useState(0)
  
  const options = [
    { label: "Generate with Claude (recommended)", value: "generate" },
    { label: "Manual configuration", value: "manual" }
  ]

  const handleChange = (value: string) => {
    setCreateState({ type: 'SET_METHOD', value: value as 'generate' | 'manual' })
    if (value === "generate") {
      setCreateState({ type: 'SET_IS_AI_GENERATED', value: true })
      setModeState({ mode: "create-generate", location: createState.location })
    } else {
      setCreateState({ type: 'SET_IS_AI_GENERATED', value: false })
      setModeState({ mode: "create-type", location: createState.location })
    }
  }

  const handleCancel = () => {
    setModeState({ mode: "create-location" })
  }

  useInput((input, key) => {
    if (key.escape) {
      handleCancel()
    } else if (key.return) {
      handleChange(options[selectedIndex].value)
    } else if (key.upArrow) {
      setSelectedIndex(prev => prev > 0 ? prev - 1 : options.length - 1)
    } else if (key.downArrow) {
      setSelectedIndex(prev => prev < options.length - 1 ? prev + 1 : 0)
    }
  })

  return (
    <Box flexDirection="column">
      <Header title="Create new agent" subtitle="Creation method" step={2} totalSteps={9}>
        <Box marginTop={1}>
          <SelectList 
            options={options}
            selectedIndex={selectedIndex}
            onChange={handleChange}
            onCancel={handleCancel}
          />
        </Box>
      </Header>
      <InstructionBar />
    </Box>
  )
}

// Agent menu for agent operations
interface AgentMenuProps {
  agent: AgentConfig
  setModeState: (state: ModeState) => void
}

function AgentMenu({ agent, setModeState }: AgentMenuProps) {
  const [selectedIndex, setSelectedIndex] = useState(0)
  
  const options = [
    { label: "View details", value: "view" },
    { label: "Edit agent", value: "edit", disabled: agent.location === 'built-in' },
    { label: "Delete agent", value: "delete", disabled: agent.location === 'built-in' }
  ]
  
  const availableOptions = options.filter(opt => !opt.disabled)
  
  const handleSelect = (value: string) => {
    switch (value) {
      case "view":
        setModeState({ mode: "view-agent", selectedAgent: agent })
        break
      case "edit":
        setModeState({ mode: "edit-agent", selectedAgent: agent })
        break
      case "delete":
        setModeState({ mode: "delete-confirm", selectedAgent: agent })
        break
    }
  }
  
  useInput((input, key) => {
    if (key.return) {
      handleSelect(availableOptions[selectedIndex].value)
    } else if (key.upArrow) {
      setSelectedIndex(prev => prev > 0 ? prev - 1 : availableOptions.length - 1)
    } else if (key.downArrow) {
      setSelectedIndex(prev => prev < availableOptions.length - 1 ? prev + 1 : 0)
    }
  })
  
  return (
    <Box flexDirection="column">
      <Header title={`Agent: ${agent.agentType}`} subtitle={`${agent.location}`}>
        <Box marginTop={1}>
          <SelectList 
            options={availableOptions}
            selectedIndex={selectedIndex}
            onChange={handleSelect}
            numbered={false}
          />
        </Box>
      </Header>
      <InstructionBar />
    </Box>
  )
}

// Edit menu for agent editing options
interface EditMenuProps {
  agent: AgentConfig
  setModeState: (state: ModeState) => void
}

function EditMenu({ agent, setModeState }: EditMenuProps) {
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [isOpening, setIsOpening] = useState(false)
  const theme = getTheme()
  
  const options = [
    { label: "Open in editor", value: "open-editor" },
    { label: "Edit tools", value: "edit-tools" },
    { label: "Edit model", value: "edit-model" },
    { label: "Edit color", value: "edit-color" }
  ]
  
  const handleSelect = async (value: string) => {
    switch (value) {
      case "open-editor":
        setIsOpening(true)
        try {
          const filePath = getAgentFilePath(agent)
          await openInEditor(filePath)
          setModeState({ mode: "agent-menu", selectedAgent: agent })
        } catch (error) {
          console.error('Failed to open editor:', error)
          // TODO: Show error to user
        } finally {
          setIsOpening(false)
        }
        break
      case "edit-tools":
        setModeState({ mode: "edit-tools", selectedAgent: agent })
        break
      case "edit-model":
        setModeState({ mode: "edit-model", selectedAgent: agent })
        break
      case "edit-color":
        setModeState({ mode: "edit-color", selectedAgent: agent })
        break
    }
  }
  
  const handleBack = () => {
    setModeState({ mode: "agent-menu", selectedAgent: agent })
  }
  
  useInput((input, key) => {
    if (key.escape) {
      handleBack()
    } else if (key.return && !isOpening) {
      handleSelect(options[selectedIndex].value)
    } else if (key.upArrow) {
      setSelectedIndex(prev => prev > 0 ? prev - 1 : options.length - 1)
    } else if (key.downArrow) {
      setSelectedIndex(prev => prev < options.length - 1 ? prev + 1 : 0)
    }
  })
  
  if (isOpening) {
    return (
      <Box flexDirection="column">
        <Header title={`Edit agent: ${agent.agentType}`} subtitle="Opening in editor...">
          <Box marginTop={1}>
            <LoadingSpinner text="Opening file in editor..." />
          </Box>
        </Header>
        <InstructionBar />
      </Box>
    )
  }
  
  return (
    <Box flexDirection="column">
      <Header title={`Edit agent: ${agent.agentType}`} subtitle={`Location: ${agent.location}`}>
        <Box marginTop={1}>
          <SelectList 
            options={options}
            selectedIndex={selectedIndex}
            onChange={handleSelect}
            numbered={false}
          />
        </Box>
      </Header>
      <InstructionBar instructions="↑↓ navigate · Enter select · Esc back" />
    </Box>
  )
}

// Edit tools step
interface EditToolsStepProps {
  agent: AgentConfig
  tools: Tool[]
  setModeState: (state: ModeState) => void
  onAgentUpdated: (message: string, updated: AgentConfig) => void
}

function EditToolsStep({ agent, tools, setModeState, onAgentUpdated }: EditToolsStepProps) {
  const [selectedIndex, setSelectedIndex] = useState(0)
  
  // Initialize selected tools based on agent.tools
  const initialTools = Array.isArray(agent.tools) ? agent.tools : 
                       agent.tools === '*' ? tools.map(t => t.name) : []
  const [selectedTools, setSelectedTools] = useState<Set<string>>(new Set(initialTools))
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [isUpdating, setIsUpdating] = useState(false)
  
  // Categorize tools
  const categorizedTools = useMemo(() => {
    const categories: Record<string, Tool[]> = {
      read: [],
      edit: [],
      execution: [],
      web: [],
      other: []
    }
    
    tools.forEach(tool => {
      let categorized = false
      
      // Check built-in categories
      for (const [category, toolNames] of Object.entries(TOOL_CATEGORIES)) {
        if (Array.isArray(toolNames) && toolNames.includes(tool.name)) {
          categories[category as keyof typeof categories]?.push(tool)
          categorized = true
          break
        }
      }
      
      if (!categorized) {
        categories.other.push(tool)
      }
    })
    
    return categories
  }, [tools])
  
  const allSelected = selectedTools.size === tools.length && tools.length > 0
  const readSelected = categorizedTools.read.every(tool => selectedTools.has(tool.name)) && categorizedTools.read.length > 0
  const editSelected = categorizedTools.edit.every(tool => selectedTools.has(tool.name)) && categorizedTools.edit.length > 0
  const execSelected = categorizedTools.execution.every(tool => selectedTools.has(tool.name)) && categorizedTools.execution.length > 0
  
  const options = [
    { id: 'continue', label: 'Save', isContinue: true },
    { id: 'separator1', label: '────────────────────────────────────', isSeparator: true },
    { id: 'all', label: `${allSelected ? UI_ICONS.checkboxOn : UI_ICONS.checkboxOff} All tools`, isAll: true },
    { id: 'read', label: `${readSelected ? UI_ICONS.checkboxOn : UI_ICONS.checkboxOff} Read-only tools`, isCategory: true },
    { id: 'edit', label: `${editSelected ? UI_ICONS.checkboxOn : UI_ICONS.checkboxOff} Edit tools`, isCategory: true },
    { id: 'execution', label: `${execSelected ? UI_ICONS.checkboxOn : UI_ICONS.checkboxOff} Execution tools`, isCategory: true },
    { id: 'separator2', label: '────────────────────────────────────', isSeparator: true },
    { id: 'advanced', label: `[ ${showAdvanced ? 'Hide' : 'Show'} advanced options ]`, isAdvancedToggle: true },
    ...(showAdvanced ? tools.map(tool => ({
      id: tool.name,
      label: `${selectedTools.has(tool.name) ? UI_ICONS.checkboxOn : UI_ICONS.checkboxOff} ${tool.name}`,
      isTool: true
    })) : [])
  ]
  
  const handleSave = async () => {
    setIsUpdating(true)
    try {
      // Type-safe tools conversion for updateAgent
      const toolsArray: string[] | '*' = allSelected ? '*' : Array.from(selectedTools)
      await updateAgent(agent, agent.whenToUse, toolsArray, agent.systemPrompt, agent.color, (agent as any).model)
      
      // Clear cache and reload fresh agent data from file system
      clearAgentCache()
      const freshAgents = await getActiveAgents()
      const updatedAgent = freshAgents.find(a => a.agentType === agent.agentType)
      
      if (updatedAgent) {
        onAgentUpdated(`Updated tools for agent: ${agent.agentType}`, updatedAgent)
        setModeState({ mode: "edit-agent", selectedAgent: updatedAgent })
      } else {
        console.error('Failed to find updated agent after save')
        // Fallback to manual update
        const fallbackAgent: AgentConfig = {
          ...agent,
          tools: toolsArray.length === 1 && toolsArray[0] === '*' ? '*' : toolsArray,
        }
        onAgentUpdated(`Updated tools for agent: ${agent.agentType}`, fallbackAgent)
        setModeState({ mode: "edit-agent", selectedAgent: fallbackAgent })
      }
    } catch (error) {
      console.error('Failed to update agent tools:', error)
      // TODO: Show error to user
    } finally {
      setIsUpdating(false)
    }
  }
  
  const handleSelect = () => {
    const option = options[selectedIndex] as any // Type assertion for union type
    if (!option) return
    if (option.isSeparator) return
    
    if (option.isContinue) {
      handleSave()
    } else if (option.isAdvancedToggle) {
      setShowAdvanced(!showAdvanced)
    } else if (option.isAll) {
      if (allSelected) {
        setSelectedTools(new Set())
      } else {
        setSelectedTools(new Set(tools.map(t => t.name)))
      }
    } else if (option.isCategory) {
      const categoryName = option.id as keyof typeof categorizedTools
      const categoryTools = categorizedTools[categoryName] || []
      const newSelected = new Set(selectedTools)
      
      const categorySelected = categoryTools.every(tool => selectedTools.has(tool.name))
      if (categorySelected) {
        categoryTools.forEach(tool => newSelected.delete(tool.name))
      } else {
        categoryTools.forEach(tool => newSelected.add(tool.name))
      }
      setSelectedTools(newSelected)
    } else if (option.isTool) {
      const newSelected = new Set(selectedTools)
      if (newSelected.has(option.id)) {
        newSelected.delete(option.id)
      } else {
        newSelected.add(option.id)
      }
      setSelectedTools(newSelected)
    }
  }
  
  useInput((input, key) => {
    if (key.escape) {
      setModeState({ mode: "edit-agent", selectedAgent: agent })
    } else if (key.return && !isUpdating) {
      handleSelect()
    } else if (key.upArrow) {
      setSelectedIndex(prev => {
        let newIndex = prev > 0 ? prev - 1 : options.length - 1
        // Skip separators when going up
        while (options[newIndex] && (options[newIndex] as any).isSeparator) {
          newIndex = newIndex > 0 ? newIndex - 1 : options.length - 1
        }
        return newIndex
      })
    } else if (key.downArrow) {
      setSelectedIndex(prev => {
        let newIndex = prev < options.length - 1 ? prev + 1 : 0
        // Skip separators when going down
        while (options[newIndex] && (options[newIndex] as any).isSeparator) {
          newIndex = newIndex < options.length - 1 ? newIndex + 1 : 0
        }
        return newIndex
      })
    }
  })
  
  if (isUpdating) {
    return (
      <Box flexDirection="column">
        <Header title={`Edit agent: ${agent.agentType}`}>
          <Box marginTop={1}>
            <LoadingSpinner text="Updating agent tools..." />
          </Box>
        </Header>
        <InstructionBar />
      </Box>
    )
  }
  
  return (
    <Box flexDirection="column">
      <Header title={`Edit agent: ${agent.agentType}`}>
        <Box flexDirection="column" marginTop={1}>
          {options.map((option, idx) => {
            const isSelected = idx === selectedIndex
            const isContinue = 'isContinue' in option && option.isContinue
            const isAdvancedToggle = (option as any).isAdvancedToggle
            const isSeparator = (option as any).isSeparator
            
            return (
              <Box key={option.id}>
                <Text 
                  color={isSelected && !isSeparator ? 'cyan' : isSeparator ? 'gray' : undefined}
                  bold={isContinue}
                  dimColor={isSeparator}
                >
                  {isSeparator ? 
                    option.label : 
                    `${isSelected ? `${UI_ICONS.pointer} ` : '  '}${isContinue || isAdvancedToggle ? option.label : option.label}`
                  }
                </Text>
                {(option as any).isTool && isSelected && tools.find(t => t.name === option.id)?.description && (
                  <Box marginLeft={4}>
                    <Text dimColor>{tools.find(t => t.name === option.id)?.description}</Text>
                  </Box>
                )}
              </Box>
            )
          })}
          
          <Box marginTop={1}>
            <Text dimColor>
              {allSelected ? 
                'All tools selected' : 
                `${selectedTools.size} of ${tools.length} tools selected`}
            </Text>
          </Box>
        </Box>
      </Header>
      <InstructionBar instructions="Enter toggle selection · ↑↓ navigate · Esc back" />
    </Box>
  )
}

// Edit model step
interface EditModelStepProps {
  agent: AgentConfig
  setModeState: (state: ModeState) => void
  onAgentUpdated: (message: string, updated: AgentConfig) => void
}

function EditModelStep({ agent, setModeState, onAgentUpdated }: EditModelStepProps) {
  const manager = getModelManager()
  const profiles = manager.getActiveModelProfiles()
  const currentModel = (agent as any).model || null
  
  // Build model options array
  const modelOptions = [
    { id: null, name: 'Inherit from parent', description: 'Use the model from task configuration' },
    ...profiles.map((p: any) => ({ id: p.modelName, name: p.name, description: `${p.provider || 'provider'} · ${p.modelName}` }))
  ]

  // Find the index of current model
  const defaultIndex = modelOptions.findIndex(m => m.id === currentModel)
  const [selectedIndex, setSelectedIndex] = useState(defaultIndex >= 0 ? defaultIndex : 0)
  const [isUpdating, setIsUpdating] = useState(false)

  const handleSave = async (modelId: string | null) => {
    setIsUpdating(true)
    try {
      const modelValue = modelId === null ? undefined : modelId
      await updateAgent(agent, agent.whenToUse, agent.tools, agent.systemPrompt, agent.color, modelValue)
      
      // Clear cache and reload fresh agent data from file system
      clearAgentCache()
      const freshAgents = await getActiveAgents()
      const updatedAgent = freshAgents.find(a => a.agentType === agent.agentType)
      
      if (updatedAgent) {
        onAgentUpdated(`Updated model for agent: ${agent.agentType}`, updatedAgent)
        setModeState({ mode: 'edit-agent', selectedAgent: updatedAgent })
      } else {
        console.error('Failed to find updated agent after save')
        // Fallback to manual update
        const fallbackAgent: AgentConfig = { ...agent }
        if (modelValue) {
          (fallbackAgent as any).model = modelValue
        } else {
          delete (fallbackAgent as any).model
        }
        onAgentUpdated(`Updated model for agent: ${agent.agentType}`, fallbackAgent)
        setModeState({ mode: 'edit-agent', selectedAgent: fallbackAgent })
      }
    } catch (error) {
      console.error('Failed to update agent model:', error)
    } finally {
      setIsUpdating(false)
    }
  }

  useInput((input, key) => {
    if (key.escape) {
      setModeState({ mode: 'edit-agent', selectedAgent: agent })
    } else if (key.return && !isUpdating) {
      handleSave(modelOptions[selectedIndex].id)
    } else if (key.upArrow) {
      setSelectedIndex(prev => (prev > 0 ? prev - 1 : modelOptions.length - 1))
    } else if (key.downArrow) {
      setSelectedIndex(prev => (prev < modelOptions.length - 1 ? prev + 1 : 0))
    }
  })

  if (isUpdating) {
    return (
      <Box flexDirection="column">
        <Header title={`Edit agent: ${agent.agentType}`}>
          <Box marginTop={1}>
            <LoadingSpinner text="Updating agent model..." />
          </Box>
        </Header>
        <InstructionBar />
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Header title={`Edit agent: ${agent.agentType}`} subtitle="Model determines the agent's reasoning capabilities and speed.">
        <Box marginTop={2}>
          <SelectList
            options={modelOptions.map((m, i) => ({ label: `${i + 1}. ${m.name}${m.description ? `\n${m.description}` : ''}`, value: m.id }))}
            selectedIndex={selectedIndex}
            onChange={(val) => handleSave(val)}
            numbered={false}
          />
        </Box>
      </Header>
      <InstructionBar instructions="↑↓ navigate · Enter select · Esc back" />
    </Box>
  )
}

// Edit color step
interface EditColorStepProps {
  agent: AgentConfig
  setModeState: (state: ModeState) => void
  onAgentUpdated: (message: string, updated: AgentConfig) => void
}

function EditColorStep({ agent, setModeState, onAgentUpdated }: EditColorStepProps) {
  const currentColor = agent.color || null
  
  // Define color options (removed red/green due to display issues)
  const colors = [
    { label: 'Automatic color', value: null },
    { label: 'Yellow', value: 'yellow' },
    { label: 'Blue', value: 'blue' },
    { label: 'Magenta', value: 'magenta' },
    { label: 'Cyan', value: 'cyan' },
    { label: 'Gray', value: 'gray' },
    { label: 'White', value: 'white' }
  ]
  
  // Find current color index
  const defaultIndex = colors.findIndex(color => color.value === currentColor)
  const [selectedIndex, setSelectedIndex] = useState(defaultIndex >= 0 ? defaultIndex : 0)
  const [isUpdating, setIsUpdating] = useState(false)
  
  const handleSave = async (color: string | null) => {
    setIsUpdating(true)
    try {
      const colorValue = color === null ? undefined : color
      await updateAgent(agent, agent.whenToUse, agent.tools, agent.systemPrompt, colorValue, (agent as any).model)
      
      // Clear cache and reload fresh agent data from file system
      clearAgentCache()
      const freshAgents = await getActiveAgents()
      const updatedAgent = freshAgents.find(a => a.agentType === agent.agentType)
      
      if (updatedAgent) {
        onAgentUpdated(`Updated color for agent: ${agent.agentType}`, updatedAgent)
        setModeState({ mode: "edit-agent", selectedAgent: updatedAgent })
      } else {
        console.error('Failed to find updated agent after save')
        // Fallback to manual update
        const fallbackAgent: AgentConfig = { ...agent, ...(colorValue ? { color: colorValue } : { color: undefined }) }
        onAgentUpdated(`Updated color for agent: ${agent.agentType}`, fallbackAgent)
        setModeState({ mode: "edit-agent", selectedAgent: fallbackAgent })
      }
    } catch (error) {
      console.error('Failed to update agent color:', error)
      // TODO: Show error to user
    } finally {
      setIsUpdating(false)
    }
  }
  
  useInput((input, key) => {
    if (key.escape) {
      setModeState({ mode: "edit-agent", selectedAgent: agent })
    } else if (key.return && !isUpdating) {
      handleSave(colors[selectedIndex].value)
    } else if (key.upArrow) {
      setSelectedIndex(prev => prev > 0 ? prev - 1 : colors.length - 1)
    } else if (key.downArrow) {
      setSelectedIndex(prev => prev < colors.length - 1 ? prev + 1 : 0)
    }
  })
  
  if (isUpdating) {
    return (
      <Box flexDirection="column">
        <Header title={`Edit agent: ${agent.agentType}`}>
          <Box marginTop={1}>
            <LoadingSpinner text="Updating agent color..." />
          </Box>
        </Header>
        <InstructionBar />
      </Box>
    )
  }
  
  const selectedColor = colors[selectedIndex]
  const previewColor = selectedColor.value || undefined
  
  return (
    <Box flexDirection="column">
      <Header title={`Edit agent: ${agent.agentType}`} subtitle="Choose background color">
        <Box flexDirection="column" marginTop={1}>
          {colors.map((color, index) => {
            const isSelected = index === selectedIndex
            const isCurrent = color.value === currentColor
            
            return (
              <Box key={color.value || 'automatic'}>
                <Text color={isSelected ? 'cyan' : undefined}>
                  {isSelected ? '❯ ' : '  '}
                </Text>
                <Text color={color.value || undefined}>●</Text>
                <Text>
                  {' '}{color.label}
                  {isCurrent && (
                    <Text color="green"> ✔</Text>
                  )}
                </Text>
              </Box>
            )
          })}
          
          <Box marginTop={2}>
            <Text>Preview: </Text>
            <Text color={previewColor}>{agent.agentType}</Text>
          </Box>
        </Box>
      </Header>
      <InstructionBar instructions="↑↓ navigate · Enter select · Esc back" />
    </Box>
  )
}

// View agent details
interface ViewAgentProps {
  agent: AgentConfig
  tools: Tool[]
  setModeState: (state: ModeState) => void
}

function ViewAgent({ agent, tools, setModeState }: ViewAgentProps) {
  const theme = getTheme()
  const agentTools = Array.isArray(agent.tools) ? agent.tools : []
  const hasAllTools = agent.tools === "*" || agentTools.includes("*")
  const locationPath = agent.location === 'user'
    ? `~/.claude/agents/${agent.agentType}.md`
    : agent.location === 'project'
      ? `.claude/agents/${agent.agentType}.md`
      : '(built-in)'
  const displayModel = getDisplayModelName((agent as any).model || null)
  
  const allowedTools = useMemo(() => {
    if (hasAllTools) return tools
    
    return tools.filter(tool => 
      agentTools.some(allowedTool => {
        if (allowedTool.includes("*")) {
          const prefix = allowedTool.replace("*", "")
          return tool.name.startsWith(prefix)
        }
        return tool.name === allowedTool
      })
    )
  }, [tools, agentTools, hasAllTools])
  
  return (
    <Box flexDirection="column">
      <Header title={`Agent: ${agent.agentType}`} subtitle="Details">
        <Box flexDirection="column" marginTop={1}>
          <Text><Text bold>Type:</Text> {agent.agentType}</Text>
          <Text><Text bold>Location:</Text> {agent.location} {locationPath !== '(built-in)' ? `· ${locationPath}` : ''}</Text>
          <Text><Text bold>Description:</Text> {agent.whenToUse}</Text>
          <Text><Text bold>Model:</Text> {displayModel}</Text>
          <Text><Text bold>Color:</Text> {agent.color || 'auto'}</Text>
          
          <Box marginTop={1}>
            <Text bold>Tools:</Text>
          </Box>
          {hasAllTools ? (
            <Text color={theme.secondary}>All tools ({tools.length} available)</Text>
          ) : (
            <Box flexDirection="column" paddingLeft={2}>
              {allowedTools.map(tool => (
                <Fragment key={tool.name}>
                  <Text color={theme.secondary}>• {tool.name}</Text>
                </Fragment>
              ))}
            </Box>
          )}
          
          <Box marginTop={1}>
            <Text bold>System Prompt:</Text>
          </Box>
          <Box paddingLeft={2}>
            <Text>{agent.systemPrompt}</Text>
          </Box>
        </Box>
      </Header>
      <InstructionBar />
    </Box>
  )
}

// Edit agent component
interface EditAgentProps {
  agent: AgentConfig
  tools: Tool[]
  setModeState: (state: ModeState) => void
  onAgentUpdated: (message: string) => void
}

function EditAgent({ agent, tools, setModeState, onAgentUpdated }: EditAgentProps) {
  const theme = getTheme()
  const [currentStep, setCurrentStep] = useState<'description' | 'tools' | 'prompt' | 'confirm'>('description')
  const [isUpdating, setIsUpdating] = useState(false)
  
  // 编辑状态
  const [editedDescription, setEditedDescription] = useState(agent.whenToUse)
  const [editedTools, setEditedTools] = useState<string[]>(
    Array.isArray(agent.tools) ? agent.tools : agent.tools === '*' ? ['*'] : []
  )
  const [editedPrompt, setEditedPrompt] = useState(agent.systemPrompt)
  const [error, setError] = useState<string | null>(null)
  
  const handleSave = async () => {
    setIsUpdating(true)
    try {
      await updateAgent(agent, editedDescription, editedTools, editedPrompt, agent.color)
      clearAgentCache()
      onAgentUpdated(`Updated agent: ${agent.agentType}`)
    } catch (error) {
      setError((error as Error).message)
      setIsUpdating(false)
    }
  }
  
  const renderStepContent = () => {
    switch (currentStep) {
      case 'description':
        return (
          <Box flexDirection="column">
            <Text bold>Edit Description:</Text>
            <Box marginTop={1}>
              <MultilineTextInput
                value={editedDescription}
                onChange={setEditedDescription}
                placeholder="Describe when to use this agent..."
                onSubmit={() => setCurrentStep('tools')}
                error={error}
                rows={4}
              />
            </Box>
          </Box>
        )
        
      case 'tools':
        return (
          <Box flexDirection="column">
            <Text bold>Edit Tools:</Text>
            <Box marginTop={1}>
              <ToolsStep
                createState={{
                  selectedTools: editedTools,
                } as CreateState}
                setCreateState={(action) => {
                  if (action.type === 'SET_SELECTED_TOOLS') {
                    setEditedTools(action.value)
                    setCurrentStep('prompt')
                  }
                }}
                setModeState={() => {}}
                tools={tools}
              />
            </Box>
          </Box>
        )
        
      case 'prompt':
        return (
          <Box flexDirection="column">
            <Text bold>Edit System Prompt:</Text>
            <Box marginTop={1}>
              <MultilineTextInput
                value={editedPrompt}
                onChange={setEditedPrompt}
                placeholder="System prompt for the agent..."
                onSubmit={() => setCurrentStep('confirm')}
                error={error}
                rows={5}
              />
            </Box>
          </Box>
        )
        
      case 'confirm':
        const validation = validateAgentConfig({
          agentType: agent.agentType,
          whenToUse: editedDescription,
          systemPrompt: editedPrompt,
          selectedTools: editedTools
        })
        
        return (
          <Box flexDirection="column">
            <Text bold>Confirm Changes:</Text>
            <Box flexDirection="column" marginTop={1}>
              <Text><Text bold>Agent:</Text> {agent.agentType}</Text>
              <Text><Text bold>Description:</Text> {editedDescription}</Text>
              <Text><Text bold>Tools:</Text> {editedTools.includes('*') ? 'All tools' : editedTools.join(', ')}</Text>
              <Text><Text bold>System Prompt:</Text> {editedPrompt.slice(0, 100)}{editedPrompt.length > 100 ? '...' : ''}</Text>
              
              {validation.warnings.length > 0 && (
                <Box marginTop={1}>
                  {validation.warnings.map((warning, idx) => (
                    <Fragment key={idx}>
                      <Text color={theme.warning}>⚠ {warning}</Text>
                    </Fragment>
                  ))}
                </Box>
              )}
              
              {error && (
                <Box marginTop={1}>
                  <Text color={theme.error}>✗ {error}</Text>
                </Box>
              )}
              
              <Box marginTop={2}>
                {isUpdating ? (
                  <LoadingSpinner text="Updating agent..." />
                ) : (
                  <Text>Press Enter to save changes</Text>
                )}
              </Box>
            </Box>
          </Box>
        )
    }
  }
  
  useInput((input, key) => {
    if (key.escape) {
      if (currentStep === 'description') {
        setModeState({ mode: "agent-menu", selectedAgent: agent })
      } else {
        // 返回上一步
        const steps: Array<typeof currentStep> = ['description', 'tools', 'prompt', 'confirm']
        const currentIndex = steps.indexOf(currentStep)
        if (currentIndex > 0) {
          setCurrentStep(steps[currentIndex - 1])
        }
      }
      return
    }
    
    if (key.return && currentStep === 'confirm' && !isUpdating) {
      handleSave()
    }
  })
  
  return (
    <Box flexDirection="column">
      <Header title={`Edit Agent: ${agent.agentType}`} subtitle={`Step ${['description', 'tools', 'prompt', 'confirm'].indexOf(currentStep) + 1}/4`}>
        <Box marginTop={1}>
          {renderStepContent()}
        </Box>
      </Header>
      <InstructionBar 
        instructions={currentStep === 'confirm' ? 
          "Press Enter to save · Esc to go back" :
          "Enter to continue · Esc to go back"
        }
      />
    </Box>
  )
}

// Delete confirmation
interface DeleteConfirmProps {
  agent: AgentConfig
  setModeState: (state: ModeState) => void
  onAgentDeleted: (message: string) => void
}

function DeleteConfirm({ agent, setModeState, onAgentDeleted }: DeleteConfirmProps) {
  const [isDeleting, setIsDeleting] = useState(false)
  const [selected, setSelected] = useState(false) // false = No, true = Yes
  
  const handleConfirm = async () => {
    if (selected) {
      setIsDeleting(true)
      try {
        await deleteAgent(agent)
        clearAgentCache()
        onAgentDeleted(`Deleted agent: ${agent.agentType}`)
      } catch (error) {
        console.error('Failed to delete agent:', error)
        setIsDeleting(false)
        // TODO: Show error to user
      }
    } else {
      setModeState({ mode: "agent-menu", selectedAgent: agent })
    }
  }
  
  useInput((input, key) => {
    if (key.return) {
      handleConfirm()
    } else if (key.leftArrow || key.rightArrow || key.tab) {
      setSelected(!selected)
    }
  })
  
  if (isDeleting) {
    return (
      <Box flexDirection="column">
        <Header title="Delete agent" subtitle="Deleting...">
          <Box marginTop={1}>
            <LoadingSpinner text="Deleting agent..." />
          </Box>
        </Header>
        <InstructionBar />
      </Box>
    )
  }
  
  return (
    <Box flexDirection="column">
      <Header title="Delete agent" subtitle={`Delete "${agent.agentType}"?`}>
        <Box marginTop={1}>
          <Text>This action cannot be undone. The agent file will be permanently deleted.</Text>
          <Box marginTop={2} gap={3}>
            <Text color={!selected ? 'cyan' : undefined}>
              {!selected ? `${UI_ICONS.pointer} ` : '  '}No
            </Text>
            <Text color={selected ? 'red' : undefined}>
              {selected ? `${UI_ICONS.pointer} ` : '  '}Yes, delete
            </Text>
          </Box>
        </Box>
      </Header>
      <InstructionBar />
    </Box>
  )
}

export default {
  name: 'agents',
  description: 'Manage agent configurations',
  type: 'local-jsx' as const,
  isEnabled: true,
  isHidden: false,
  
  async call(onExit: (message?: string) => void) {
    return <AgentsUI onExit={onExit} />
  },
  
  userFacingName() {
    return 'agents'
  }
}
