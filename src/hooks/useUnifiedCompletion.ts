import { useState, useCallback, useEffect, useRef } from 'react'
import { useInput } from 'ink'
import { existsSync, statSync, readdirSync } from 'fs'
import { join, dirname, basename, resolve } from 'path'
import { getCwd } from '../utils/state'
import { getCommand } from '../commands'
import { getActiveAgents } from '../utils/agentLoader'
import { getModelManager } from '../utils/model'
import { glob } from 'glob'
import { matchCommands } from '../utils/fuzzyMatcher'
import { 
  getCommonSystemCommands, 
  getCommandPriority,
  getEssentialCommands,
  getMinimalFallbackCommands 
} from '../utils/commonUnixCommands'
import type { Command } from '../commands'

// Unified suggestion type for all completion types
export interface UnifiedSuggestion {
  value: string
  displayValue: string
  type: 'command' | 'agent' | 'file' | 'ask'
  icon?: string
  score: number
  metadata?: any
  // Clean type system for smart matching
  isSmartMatch?: boolean  // Instead of magic string checking
  originalContext?: 'mention' | 'file' | 'command'  // Track source context
}

interface CompletionContext {
  type: 'command' | 'agent' | 'file' | null
  prefix: string
  startPos: number
  endPos: number
}

// Terminal behavior state for preview and cycling
interface TerminalState {
  originalWord: string
  wordContext: { start: number; end: number } | null
  isPreviewMode: boolean
}

interface Props {
  input: string
  cursorOffset: number
  onInputChange: (value: string) => void
  setCursorOffset: (offset: number) => void
  commands: Command[]
  onSubmit?: (value: string, isSubmittingSlashCommand?: boolean) => void
}

/**
 * Unified completion system - Linus approved
 * One hook to rule them all, no bullshit, no complexity
 */
// Unified completion state - single source of truth
interface CompletionState {
  suggestions: UnifiedSuggestion[]
  selectedIndex: number
  isActive: boolean
  context: CompletionContext | null
  preview: {
    isActive: boolean
    originalInput: string
    wordRange: [number, number]
  } | null
  emptyDirMessage: string
  suppressUntil: number // timestamp for suppression
}

const INITIAL_STATE: CompletionState = {
  suggestions: [],
  selectedIndex: 0,
  isActive: false,
  context: null,
  preview: null,
  emptyDirMessage: '',
  suppressUntil: 0
}

export function useUnifiedCompletion({
  input,
  cursorOffset,
  onInputChange,
  setCursorOffset,
  commands,
  onSubmit,
}: Props) {
  // Single state for entire completion system - Linus approved
  const [state, setState] = useState<CompletionState>(INITIAL_STATE)

  // State update helpers - clean and simple
  const updateState = useCallback((updates: Partial<CompletionState>) => {
    setState(prev => ({ ...prev, ...updates }))
  }, [])

  const resetCompletion = useCallback(() => {
    setState(prev => ({
      ...prev,
      suggestions: [],
      selectedIndex: 0,
      isActive: false,
      context: null,
      preview: null,
      emptyDirMessage: ''
    }))
  }, [])

  const activateCompletion = useCallback((suggestions: UnifiedSuggestion[], context: CompletionContext) => {
    setState(prev => ({
      ...prev,
      suggestions: suggestions, // Keep the order from generateSuggestions (already sorted with weights)
      selectedIndex: 0,
      isActive: true,
      context,
      preview: null
    }))
  }, [])

  // Direct state access - no legacy wrappers needed
  const { suggestions, selectedIndex, isActive, emptyDirMessage } = state

  // Find common prefix among suggestions (terminal behavior)
  const findCommonPrefix = useCallback((suggestions: UnifiedSuggestion[]): string => {
    if (suggestions.length === 0) return ''
    if (suggestions.length === 1) return suggestions[0].value
    
    let prefix = suggestions[0].value
    
    for (let i = 1; i < suggestions.length; i++) {
      const str = suggestions[i].value
      let j = 0
      while (j < prefix.length && j < str.length && prefix[j] === str[j]) {
        j++
      }
      prefix = prefix.slice(0, j)
      
      if (prefix.length === 0) return ''
    }
    
    return prefix
  }, [])

  // Clean word detection - Linus approved simplicity
  const getWordAtCursor = useCallback((): CompletionContext | null => {
    if (!input) return null
    
    // IMPORTANT: Only match the word/prefix BEFORE the cursor
    // Don't include text after cursor to avoid confusion
    let start = cursorOffset
    
    // Move start backwards to find word beginning
    // Stop at whitespace or special boundaries
    while (start > 0) {
      const char = input[start - 1]
      // Stop at whitespace
      if (/\s/.test(char)) break
      
      // For @mentions, include @ and stop
      if (char === '@' && start < cursorOffset) {
        start--
        break
      }
      
      // For paths, be smarter about / handling
      if (char === '/') {
        // Look ahead to see what we've collected so far
        const collectedSoFar = input.slice(start, cursorOffset)
        
        // If we already have a path component, this / is part of the path
        if (collectedSoFar.includes('/') || collectedSoFar.includes('.')) {
          start--
          continue
        }
        
        // Check if this is part of a path pattern like ./ or ../ or ~/
        if (start > 1) {
          const prevChar = input[start - 2]
          if (prevChar === '.' || prevChar === '~') {
            // It's part of ./ or ../ or ~/ - keep going
            start--
            continue
          }
        }
        
        // Check if this is a standalone / at the beginning (command)
        if (start === 1 || (start > 1 && /\s/.test(input[start - 2]))) {
          start--
          break // It's a command slash
        }
        
        // Otherwise treat as path separator
        start--
        continue
      }
      
      // Special handling for dots in paths
      if (char === '.' && start > 0) {
        // Check if this might be start of ./ or ../
        const nextChar = start < input.length ? input[start] : ''
        if (nextChar === '/' || nextChar === '.') {
          start--
          continue // Part of a path pattern
        }
      }
      
      start--
    }
    
    // The word is from start to cursor position (not beyond)
    const word = input.slice(start, cursorOffset)
    if (!word) return null
    
    // Priority-based type detection - no special cases needed
    if (word.startsWith('/')) {
      const beforeWord = input.slice(0, start).trim()
      const isCommand = beforeWord === '' && !word.includes('/', 1)
      return {
        type: isCommand ? 'command' : 'file',
        prefix: isCommand ? word.slice(1) : word,
        startPos: start,
        endPos: cursorOffset // Use cursor position as end
      }
    }
    
    if (word.startsWith('@')) {
      const content = word.slice(1) // Remove @
      
      // Check if this looks like an email (contains @ in the middle)
      if (word.includes('@', 1)) {
        // This looks like an email, treat as regular text
        return null
      }
      
      // Trigger completion for @mentions (agents, ask-models, files)
      return {
        type: 'agent', // This will trigger mixed agent+file completion
        prefix: content,
        startPos: start,
        endPos: cursorOffset // Use cursor position as end
      }
    }
    
    // Everything else defaults to file completion
    return {
      type: 'file', 
      prefix: word,
      startPos: start,
      endPos: cursorOffset // Use cursor position as end
    }
  }, [input, cursorOffset])

  // System commands cache - populated dynamically from $PATH
  const [systemCommands, setSystemCommands] = useState<string[]>([])
  const [isLoadingCommands, setIsLoadingCommands] = useState(false)
  
  // Dynamic command classification based on intrinsic features
  const classifyCommand = useCallback((cmd: string): 'core' | 'common' | 'dev' | 'system' => {
    const lowerCmd = cmd.toLowerCase()
    let score = 0
    
    // === FEATURE 1: Name Length & Complexity ===
    // Short, simple names are usually core commands
    if (cmd.length <= 4) score += 40
    else if (cmd.length <= 6) score += 20
    else if (cmd.length <= 8) score += 10
    else if (cmd.length > 15) score -= 30 // Very long names are specialized
    
    // === FEATURE 2: Character Patterns ===
    // Simple alphabetic names are more likely core
    if (/^[a-z]+$/.test(lowerCmd)) score += 30
    
    // Mixed case, numbers, dots suggest specialized tools
    if (/[A-Z]/.test(cmd)) score -= 15
    if (/\d/.test(cmd)) score -= 20
    if (cmd.includes('.')) score -= 25
    if (cmd.includes('-')) score -= 10
    if (cmd.includes('_')) score -= 15
    
    // === FEATURE 3: Linguistic Patterns ===
    // Single, common English words
    const commonWords = ['list', 'copy', 'move', 'find', 'print', 'show', 'edit', 'view']
    if (commonWords.some(word => lowerCmd.includes(word.slice(0, 3)))) score += 25
    
    // Domain-specific prefixes/suffixes
    const devPrefixes = ['git', 'npm', 'node', 'py', 'docker', 'kubectl']
    if (devPrefixes.some(prefix => lowerCmd.startsWith(prefix))) score += 15
    
    // System/daemon indicators  
    const systemIndicators = ['daemon', 'helper', 'responder', 'service', 'd$', 'ctl$']
    if (systemIndicators.some(indicator => 
      indicator.endsWith('$') ? lowerCmd.endsWith(indicator.slice(0, -1)) : lowerCmd.includes(indicator)
    )) score -= 40
    
    // === FEATURE 4: File Extension Indicators ===
    // Commands with extensions are usually scripts/specialized tools
    if (/\.(pl|py|sh|rb|js)$/.test(lowerCmd)) score -= 35
    
    // === FEATURE 5: Path Location Heuristics ===
    // Note: We don't have path info here, but can infer from name patterns
    // Commands that look like they belong in /usr/local/bin or specialized dirs
    const buildToolPatterns = ['bindep', 'render', 'mako', 'webpack', 'babel', 'eslint']
    if (buildToolPatterns.some(pattern => lowerCmd.includes(pattern))) score -= 25
    
    // === FEATURE 6: Vowel/Consonant Patterns ===
    // Unix commands often have abbreviated names with few vowels
    const vowelRatio = (lowerCmd.match(/[aeiou]/g) || []).length / lowerCmd.length
    if (vowelRatio < 0.2) score += 15 // Very few vowels (like 'ls', 'cp', 'mv')
    if (vowelRatio > 0.5) score -= 10  // Too many vowels (usually full words)
    
    // === CLASSIFICATION BASED ON SCORE ===
    if (score >= 50) return 'core'      // 50+: Core unix commands
    if (score >= 20) return 'common'    // 20-49: Common dev tools  
    if (score >= -10) return 'dev'      // -10-19: Specialized dev tools
    return 'system'                     // <-10: System/edge commands
  }, [])

  // Load system commands from PATH (like real terminal)
  const loadSystemCommands = useCallback(async () => {
    if (systemCommands.length > 0 || isLoadingCommands) return // Already loaded or loading
    
    setIsLoadingCommands(true)
    try {
      const { readdirSync, statSync } = await import('fs')
      const pathDirs = (process.env.PATH || '').split(':').filter(Boolean)
      const commandSet = new Set<string>()
      
      // Get essential commands from utils
      const essentialCommands = getEssentialCommands()
      
      // Add essential commands first
      essentialCommands.forEach(cmd => commandSet.add(cmd))
      
      // Scan PATH directories for executables
      for (const dir of pathDirs) {
        try {
          if (readdirSync && statSync) {
            const entries = readdirSync(dir)
            for (const entry of entries) {
              try {
                const fullPath = `${dir}/${entry}`
                const stats = statSync(fullPath)
                // Check if it's executable (rough check)
                if (stats.isFile() && (stats.mode & 0o111) !== 0) {
                  commandSet.add(entry)
                }
              } catch {
                // Skip files we can't stat
              }
            }
          }
        } catch {
          // Skip directories we can't read
        }
      }
      
      const commands = Array.from(commandSet).sort()
      setSystemCommands(commands)
    } catch (error) {
      console.warn('Failed to load system commands, using fallback:', error)
      // Use minimal fallback commands from utils if system scan fails
      setSystemCommands(getMinimalFallbackCommands())
    } finally {
      setIsLoadingCommands(false)
    }
  }, [systemCommands.length, isLoadingCommands])
  
  // Load commands on first use
  useEffect(() => {
    loadSystemCommands()
  }, [loadSystemCommands])

  // Generate command suggestions (slash commands)
  const generateCommandSuggestions = useCallback((prefix: string): UnifiedSuggestion[] => {
    const filteredCommands = commands.filter(cmd => !cmd.isHidden)
    
    if (!prefix) {
      // Show all commands when prefix is empty (for single /)
      return filteredCommands.map(cmd => ({
        value: cmd.userFacingName(),
        displayValue: `/${cmd.userFacingName()}`,
        type: 'command' as const,
        score: 100,
      }))
    }
    
    return filteredCommands
      .filter(cmd => {
        const names = [cmd.userFacingName(), ...(cmd.aliases || [])]
        return names.some(name => name.toLowerCase().startsWith(prefix.toLowerCase()))
      })
      .map(cmd => ({
        value: cmd.userFacingName(),
        displayValue: `/${cmd.userFacingName()}`,
        type: 'command' as const,
        score: 100 - prefix.length + (cmd.userFacingName().startsWith(prefix) ? 10 : 0),
      }))
  }, [commands])

  // Clean Unix command scoring using fuzzy matcher
  const calculateUnixCommandScore = useCallback((cmd: string, prefix: string): number => {
    const result = matchCommands([cmd], prefix)
    return result.length > 0 ? result[0].score : 0
  }, [])

  // Clean Unix command suggestions using fuzzy matcher with common commands boost
  const generateUnixCommandSuggestions = useCallback((prefix: string): UnifiedSuggestion[] => {
    if (!prefix) return []
    
    // Loading state
    if (isLoadingCommands) {
      return [{
        value: 'loading...',
        displayValue: `⏳ Loading system commands...`,
        type: 'file' as const,
        score: 0,
        metadata: { isLoading: true }
      }]
    }
    
    // IMPORTANT: Only use commands that exist on the system (intersection)
    const commonCommands = getCommonSystemCommands(systemCommands)
    
    // Deduplicate commands (in case of any duplicates)
    const uniqueCommands = Array.from(new Set(commonCommands))
    
    // Use fuzzy matcher ONLY on the unique intersection
    const matches = matchCommands(uniqueCommands, prefix)
    
    // Boost common commands
    const boostedMatches = matches.map(match => {
      const priority = getCommandPriority(match.command)
      return {
        ...match,
        score: match.score + priority * 0.5 // Add priority boost
      }
    }).sort((a, b) => b.score - a.score)
    
    // Limit results intelligently
    let results = boostedMatches.slice(0, 8)
    
    // If we have very high scores (900+), show fewer
    const perfectMatches = boostedMatches.filter(m => m.score >= 900)
    if (perfectMatches.length > 0 && perfectMatches.length <= 3) {
      results = perfectMatches
    }
    // If we have good scores (100+), prefer them
    else if (boostedMatches.length > 8) {
      const goodMatches = boostedMatches.filter(m => m.score >= 100)
      if (goodMatches.length <= 5) {
        results = goodMatches
      }
    }
    
    return results.map(item => ({
      value: item.command,
      displayValue: `$ ${item.command}`,
      type: 'command' as const,
      score: item.score,
      metadata: { isUnixCommand: true }
    }))
  }, [systemCommands, isLoadingCommands])

  // Agent suggestions cache
  const [agentSuggestions, setAgentSuggestions] = useState<UnifiedSuggestion[]>([])
  
  // Model suggestions cache
  const [modelSuggestions, setModelSuggestions] = useState<UnifiedSuggestion[]>([])
  
  // Load model suggestions
  useEffect(() => {
    try {
      const modelManager = getModelManager()
      const allModels = modelManager.getAllAvailableModelNames()
      
      const suggestions = allModels.map(modelId => {
        // Professional and clear description for expert model consultation
        return {
          value: `ask-${modelId}`,
          displayValue: `🦜 ask-${modelId} :: Consult ${modelId} for expert opinion and specialized analysis`,
          type: 'ask' as const,
          score: 90, // Higher than agents - put ask-models on top
          metadata: { modelId },
        }
      })
      
      setModelSuggestions(suggestions)
    } catch (error) {
      console.warn('[useUnifiedCompletion] Failed to load models:', error)
      // No fallback - rely on dynamic loading only
      setModelSuggestions([])
    }
  }, [])
  
  // Load agent suggestions on mount
  useEffect(() => {
    getActiveAgents().then(agents => {
      // agents is an array of AgentConfig, not an object
      const suggestions = agents.map(config => {
        // 🧠 智能描述算法 - 适应性长度控制
        let shortDesc = config.whenToUse
        
        // 移除常见的冗余前缀，但保留核心内容
        const prefixPatterns = [
          /^Use this agent when you need (assistance with: )?/i,
          /^Use PROACTIVELY (when|to) /i,
          /^Specialized in /i,
          /^Implementation specialist for /i,
          /^Design validation specialist\.? Use PROACTIVELY to /i,
          /^Task validation specialist\.? Use PROACTIVELY to /i,
          /^Requirements validation specialist\.? Use PROACTIVELY to /i
        ]
        
        for (const pattern of prefixPatterns) {
          shortDesc = shortDesc.replace(pattern, '')
        }
        
        // 🎯 精准断句算法：中英文句号感叹号优先 → 逗号 → 省略
        const findSmartBreak = (text: string, maxLength: number) => {
          if (text.length <= maxLength) return text
          
          // 第一优先级：中英文句号、感叹号
          const sentenceEndings = /[.!。！]/
          const firstSentenceMatch = text.search(sentenceEndings)
          if (firstSentenceMatch !== -1) {
            const firstSentence = text.slice(0, firstSentenceMatch).trim()
            if (firstSentence.length >= 5) {
              return firstSentence
            }
          }
          
          // 如果第一句过长，找逗号断句
          if (text.length > maxLength) {
            const commaEndings = /[,，]/
            const commas = []
            let match
            const regex = new RegExp(commaEndings, 'g')
            while ((match = regex.exec(text)) !== null) {
              commas.push(match.index)
            }
            
            // 找最后一个在maxLength内的逗号
            for (let i = commas.length - 1; i >= 0; i--) {
              const commaPos = commas[i]
              if (commaPos < maxLength) {
                const clause = text.slice(0, commaPos).trim()
                if (clause.length >= 5) {
                  return clause
                }
              }
            }
          }
          
          // 最后选择：直接省略
          return text.slice(0, maxLength) + '...'
        }
        
        shortDesc = findSmartBreak(shortDesc.trim(), 80) // 增加到80字符限制
        
        // 如果处理后为空或太短，使用原始描述
        if (!shortDesc || shortDesc.length < 5) {
          shortDesc = findSmartBreak(config.whenToUse, 80)
        }
        
        return {
          value: `run-agent-${config.agentType}`,
          displayValue: `👤 run-agent-${config.agentType} :: ${shortDesc}`, // 人类图标 + run-agent前缀 + 简洁描述
          type: 'agent' as const,
          score: 85, // Lower than ask-models
          metadata: config,
        }
      })
      // Agents loaded successfully
      setAgentSuggestions(suggestions)
    }).catch((error) => {
      console.warn('[useUnifiedCompletion] Failed to load agents:', error)
      // No fallback - rely on dynamic loading only
      setAgentSuggestions([])
    })
  }, [])

  // Generate agent and model suggestions using fuzzy matching
  const generateMentionSuggestions = useCallback((prefix: string): UnifiedSuggestion[] => {
    // Combine agent and model suggestions
    const allSuggestions = [...agentSuggestions, ...modelSuggestions]
    
    if (!prefix) {
      // Show all suggestions when prefix is empty (for single @)
      return allSuggestions.sort((a, b) => {
        // Ask models first (higher score), then agents
        if (a.type === 'ask' && b.type === 'agent') return -1
        if (a.type === 'agent' && b.type === 'ask') return 1
        return b.score - a.score
      })
    }
    
    // Use fuzzy matching for intelligent completion
    const candidates = allSuggestions.map(s => s.value)
    const matches = matchCommands(candidates, prefix)
    
    // Create result mapping with fuzzy scores
    const fuzzyResults = matches
      .map(match => {
        const suggestion = allSuggestions.find(s => s.value === match.command)!
        return {
          ...suggestion,
          score: match.score // Use fuzzy match score instead of simple scoring
        }
      })
      .sort((a, b) => {
        // Ask models first (for equal scores), then agents
        if (a.type === 'ask' && b.type === 'agent') return -1
        if (a.type === 'agent' && b.type === 'ask') return 1
        return b.score - a.score
      })
    
    return fuzzyResults
  }, [agentSuggestions, modelSuggestions])

  // Unix-style path completion - preserves user input semantics
  const generateFileSuggestions = useCallback((prefix: string, isAtReference: boolean = false): UnifiedSuggestion[] => {
    try {
      const cwd = getCwd()
      
      // Parse user input preserving original format
      const userPath = prefix || '.'
      const isAbsolutePath = userPath.startsWith('/')
      const isHomePath = userPath.startsWith('~')
      
      // Resolve search directory - but keep user's path format for output
      let searchPath: string
      if (isHomePath) {
        searchPath = userPath.replace('~', process.env.HOME || '')
      } else if (isAbsolutePath) {
        searchPath = userPath
      } else {
        searchPath = resolve(cwd, userPath)
      }
      
      // Determine search directory and filename filter
      // If path ends with '/', treat it as directory navigation
      const endsWithSlash = userPath.endsWith('/')
      const searchStat = existsSync(searchPath) ? statSync(searchPath) : null
      
      let searchDir: string
      let nameFilter: string
      
      if (endsWithSlash || searchStat?.isDirectory()) {
        // User is navigating into a directory or path ends with /
        searchDir = searchPath
        nameFilter = ''
      } else {
        // User might be typing a partial filename
        searchDir = dirname(searchPath)
        nameFilter = basename(searchPath)
      }
      
      if (!existsSync(searchDir)) return []
      
      // Get directory entries with filter
      const showHidden = nameFilter.startsWith('.') || userPath.includes('/.')
      const entries = readdirSync(searchDir)
        .filter(entry => {
          // Filter hidden files unless user explicitly wants them
          if (!showHidden && entry.startsWith('.')) return false
          // Filter by name if there's a filter
          if (nameFilter && !entry.toLowerCase().startsWith(nameFilter.toLowerCase())) return false
          return true
        })
        .sort((a, b) => {
          // Sort directories first, then files
          const aPath = join(searchDir, a)
          const bPath = join(searchDir, b)
          const aIsDir = statSync(aPath).isDirectory()
          const bIsDir = statSync(bPath).isDirectory()
          
          if (aIsDir && !bIsDir) return -1
          if (!aIsDir && bIsDir) return 1
          
          // Within same type, sort alphabetically
          return a.toLowerCase().localeCompare(b.toLowerCase())
        })
        .slice(0, 25)  // Show more entries for better visibility
      
      return entries.map(entry => {
        const entryPath = join(searchDir, entry)
        const isDir = statSync(entryPath).isDirectory()
        const icon = isDir ? '📁' : '📄'
        
        // Unix-style path building - preserve user's original path format
        let value: string
        
        if (userPath.includes('/')) {
          // User typed path with separators - maintain structure
          if (endsWithSlash) {
            // User explicitly ended with / - they're inside the directory
            value = userPath + entry + (isDir ? '/' : '')
          } else if (searchStat?.isDirectory()) {
            // Path is a directory but doesn't end with / - add separator
            value = userPath + '/' + entry + (isDir ? '/' : '')
          } else {
            // User is completing a filename - replace basename
            const userDir = userPath.includes('/') ? userPath.substring(0, userPath.lastIndexOf('/')) : ''
            value = userDir ? userDir + '/' + entry + (isDir ? '/' : '') : entry + (isDir ? '/' : '')
          }
        } else {
          // User typed simple name - check if it's an existing directory
          if (searchStat?.isDirectory()) {
            // Existing directory - navigate into it
            value = userPath + '/' + entry + (isDir ? '/' : '')
          } else {
            // Simple completion at current level
            value = entry + (isDir ? '/' : '')
          }
        }
        
        return {
          value,
          displayValue: `${icon} ${entry}${isDir ? '/' : ''}`,
          type: 'file' as const,
          score: isDir ? 80 : 70,
        }
      })
    } catch {
      return []
    }
  }, [])

  // Unified smart matching - single algorithm with different weights
  const calculateMatchScore = useCallback((suggestion: UnifiedSuggestion, prefix: string): number => {
    const lowerPrefix = prefix.toLowerCase()
    const value = suggestion.value.toLowerCase()
    const displayValue = suggestion.displayValue.toLowerCase()
    
    let matchFound = false
    let score = 0
    
    // Check for actual matches first
    if (value.startsWith(lowerPrefix)) {
      matchFound = true
      score = 100  // Highest priority
    } else if (value.includes(lowerPrefix)) {
      matchFound = true
      score = 95  
    } else if (displayValue.includes(lowerPrefix)) {
      matchFound = true
      score = 90
    } else {
      // Word boundary matching for compound names like "general" -> "run-agent-general-purpose"
      const words = value.split(/[-_]/)
      if (words.some(word => word.startsWith(lowerPrefix))) {
        matchFound = true
        score = 93
      } else {
        // Acronym matching (last resort)
        const acronym = words.map(word => word[0]).join('')
        if (acronym.startsWith(lowerPrefix)) {
          matchFound = true
          score = 88
        }
      }
    }
    
    // Only return score if we found a match
    if (!matchFound) return 0
    
    // Type preferences (small bonus)
    if (suggestion.type === 'ask') score += 2
    if (suggestion.type === 'agent') score += 1
    
    return score
  }, [])

  // Generate smart mention suggestions without data pollution
  const generateSmartMentionSuggestions = useCallback((prefix: string, sourceContext: 'file' | 'agent' = 'file'): UnifiedSuggestion[] => {
    if (!prefix || prefix.length < 2) return []
    
    const allSuggestions = [...agentSuggestions, ...modelSuggestions]
    
    return allSuggestions
      .map(suggestion => {
        const matchScore = calculateMatchScore(suggestion, prefix)
        if (matchScore === 0) return null
        
        // Clean transformation without data pollution
        return {
          ...suggestion,
          score: matchScore,
          isSmartMatch: true,
          originalContext: sourceContext,
          // Only modify display for clarity, keep value clean
          displayValue: `🎯 ${suggestion.displayValue}`
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
  }, [agentSuggestions, modelSuggestions, calculateMatchScore])

  // Generate all suggestions based on context
  const generateSuggestions = useCallback((context: CompletionContext): UnifiedSuggestion[] => {
    switch (context.type) {
      case 'command':
        return generateCommandSuggestions(context.prefix)
      case 'agent': {
        // @ reference: combine mentions and files with clean priority
        const mentionSuggestions = generateMentionSuggestions(context.prefix)
        const fileSuggestions = generateFileSuggestions(context.prefix, true) // isAtReference=true
        
        // Apply weights for @ context (agents/models should be prioritized but files visible)
        const weightedSuggestions = [
          ...mentionSuggestions.map(s => ({
            ...s,
            // In @ context, agents/models get high priority
            weightedScore: s.score + 150
          })),
          ...fileSuggestions.map(s => ({
            ...s,
            // Files get lower priority but still visible
            weightedScore: s.score + 10 // Small boost to ensure visibility
          }))
        ]
        
        // Sort by weighted score - no artificial limits
        return weightedSuggestions
          .sort((a, b) => b.weightedScore - a.weightedScore)
          .map(({ weightedScore, ...suggestion }) => suggestion)
          // No limit or very generous limit (e.g., 30 items)
      }
      case 'file': {
        // For normal input, try to match everything intelligently
        const fileSuggestions = generateFileSuggestions(context.prefix, false)
        const unixSuggestions = generateUnixCommandSuggestions(context.prefix)
        
        // IMPORTANT: Also try to match agents and models WITHOUT requiring @
        // This enables smart matching for inputs like "gp5", "daoqi", etc.
        const mentionMatches = generateMentionSuggestions(context.prefix)
          .map(s => ({
            ...s,
            isSmartMatch: true,
            // Show that @ will be added when selected
            displayValue: `\u2192 ${s.displayValue}` // Arrow to indicate it will transform
          }))
        
        // Apply source-based priority weights with special handling for exact matches
        // Priority order: Exact Unix > Unix commands > agents/models > files
        const weightedSuggestions = [
          ...unixSuggestions.map(s => ({
            ...s,
            // Unix commands get boost, but exact matches get huge boost
            sourceWeight: s.score >= 10000 ? 5000 : 200, // Exact match gets massive boost
            weightedScore: s.score >= 10000 ? s.score + 5000 : s.score + 200
          })),
          ...mentionMatches.map(s => ({
            ...s,
            // Agents/models get medium priority boost (but less to avoid overriding exact Unix)
            sourceWeight: 50,
            weightedScore: s.score + 50
          })),
          ...fileSuggestions.map(s => ({
            ...s,
            // Files get no boost (baseline)
            sourceWeight: 0,
            weightedScore: s.score
          }))
        ]
        
        // Sort by weighted score and deduplicate
        const seen = new Set<string>()
        const deduplicatedResults = weightedSuggestions
          .sort((a, b) => b.weightedScore - a.weightedScore)
          .filter(item => {
            // Filter out duplicates based on value
            if (seen.has(item.value)) return false
            seen.add(item.value)
            return true
          })
          .map(({ weightedScore, sourceWeight, ...suggestion }) => suggestion) // Remove weight fields
          // No limit - show all relevant matches
        
        return deduplicatedResults
      }
      default:
        return []
    }
  }, [generateCommandSuggestions, generateMentionSuggestions, generateFileSuggestions, generateUnixCommandSuggestions, generateSmartMentionSuggestions])


  // Complete with a suggestion - 支持万能@引用 + slash命令自动执行
  const completeWith = useCallback((suggestion: UnifiedSuggestion, context: CompletionContext) => {
    let completion: string
    
    if (context.type === 'command') {
      completion = `/${suggestion.value} `
    } else if (context.type === 'agent') {
      // 🚀 万能@引用：根据建议类型决定补全格式
      if (suggestion.type === 'agent') {
        completion = `@${suggestion.value} ` // 代理补全
      } else if (suggestion.type === 'ask') {
        completion = `@${suggestion.value} ` // Ask模型补全
      } else {
        // File reference in @mention context - no space for directories to allow expansion
        const isDirectory = suggestion.value.endsWith('/')
        completion = `@${suggestion.value}${isDirectory ? '' : ' '}` // 文件夹不加空格，文件加空格
      }
    } else {
      // Regular file completion OR smart mention matching
      if (suggestion.isSmartMatch) {
        // Smart mention - add @ prefix and space
        completion = `@${suggestion.value} `
      } else {
        // Regular file completion - no space for directories to allow expansion
        const isDirectory = suggestion.value.endsWith('/')
        completion = suggestion.value + (isDirectory ? '' : ' ')
      }
    }
    
    // Special handling for absolute paths in file completion
    // When completing an absolute path, we should replace the entire current word/path
    let actualEndPos: number
    
    if (context.type === 'file' && suggestion.value.startsWith('/') && !suggestion.isSmartMatch) {
      // For absolute paths, find the end of the current path/word
      let end = context.startPos
      while (end < input.length && input[end] !== ' ' && input[end] !== '\n') {
        end++
      }
      actualEndPos = end
    } else {
      // Original logic for other cases
      const currentWord = input.slice(context.startPos)
      const nextSpaceIndex = currentWord.indexOf(' ')
      actualEndPos = nextSpaceIndex === -1 ? input.length : context.startPos + nextSpaceIndex
    }
    
    const newInput = input.slice(0, context.startPos) + completion + input.slice(actualEndPos)
    onInputChange(newInput)
    setCursorOffset(context.startPos + completion.length)
    
    // Don't auto-execute slash commands - let user press Enter to submit
    // This gives users a chance to add arguments or modify the command
    
    // Completion applied
  }, [input, onInputChange, setCursorOffset, onSubmit, commands])

  // Partial complete to common prefix
  const partialComplete = useCallback((prefix: string, context: CompletionContext) => {
    const completion = context.type === 'command' ? `/${prefix}` :
                      context.type === 'agent' ? `@${prefix}` :
                      prefix
    
    const newInput = input.slice(0, context.startPos) + completion + input.slice(context.endPos)
    onInputChange(newInput)
    setCursorOffset(context.startPos + completion.length)
  }, [input, onInputChange, setCursorOffset])


  // Handle Tab key - simplified and unified
  useInput((input_str, key) => {
    if (!key.tab) return false
    if (key.shift) return false
    
    const context = getWordAtCursor()
    if (!context) return false
    
    // If menu is already showing, cycle through suggestions
    if (state.isActive && state.suggestions.length > 0) {
      const nextIndex = (state.selectedIndex + 1) % state.suggestions.length
      const nextSuggestion = state.suggestions[nextIndex]
      
      if (state.context) {
        // Calculate proper word boundaries
        const currentWord = input.slice(state.context.startPos)
        const wordEnd = currentWord.search(/\s/)
        const actualEndPos = wordEnd === -1 
          ? input.length 
          : state.context.startPos + wordEnd
        
        // Apply appropriate prefix based on context type and suggestion type
        let preview: string
        if (state.context.type === 'command') {
          preview = `/${nextSuggestion.value}`
        } else if (state.context.type === 'agent') {
          // For @mentions, always add @ prefix
          preview = `@${nextSuggestion.value}`
        } else if (nextSuggestion.isSmartMatch) {
          // Smart match from normal input - add @ prefix
          preview = `@${nextSuggestion.value}`
        } else {
          preview = nextSuggestion.value
        }
        
        // Apply preview
        const newInput = input.slice(0, state.context.startPos) + 
                         preview + 
                         input.slice(actualEndPos)
        
        onInputChange(newInput)
        setCursorOffset(state.context.startPos + preview.length)
        
        // Update state
        updateState({
          selectedIndex: nextIndex,
          preview: {
            isActive: true,
            originalInput: input,
            wordRange: [state.context.startPos, state.context.startPos + preview.length]
          }
        })
      }
      return true
    }
    
    // Generate new suggestions
    const currentSuggestions = generateSuggestions(context)
    
    if (currentSuggestions.length === 0) {
      return false // Let Tab pass through
    } else if (currentSuggestions.length === 1) {
      // Single match: complete immediately
      completeWith(currentSuggestions[0], context)
      return true
    } else {
      // Show menu and apply first suggestion
      activateCompletion(currentSuggestions, context)
      
      // Immediately apply first suggestion as preview
      const firstSuggestion = currentSuggestions[0]
      const currentWord = input.slice(context.startPos)
      const wordEnd = currentWord.search(/\s/)
      const actualEndPos = wordEnd === -1 
        ? input.length 
        : context.startPos + wordEnd
        
      let preview: string
      if (context.type === 'command') {
        preview = `/${firstSuggestion.value}`
      } else if (context.type === 'agent') {
        preview = `@${firstSuggestion.value}`
      } else if (firstSuggestion.isSmartMatch) {
        // Smart match from normal input - add @ prefix
        preview = `@${firstSuggestion.value}`
      } else {
        preview = firstSuggestion.value
      }
      
      const newInput = input.slice(0, context.startPos) + 
                       preview + 
                       input.slice(actualEndPos)
      
      onInputChange(newInput)
      setCursorOffset(context.startPos + preview.length)
      
      updateState({
        preview: {
          isActive: true,
          originalInput: input,
          wordRange: [context.startPos, context.startPos + preview.length]
        }
      })
      
      return true
    }
  })

  // Handle navigation keys - simplified and unified  
  useInput((inputChar, key) => {
    // Enter key - confirm selection and end completion (always add space)
    if (key.return && state.isActive && state.suggestions.length > 0) {
      const selectedSuggestion = state.suggestions[state.selectedIndex]
      if (selectedSuggestion && state.context) {
        // For Enter key, always add space even for directories to indicate completion end
        let completion: string
        
        if (state.context.type === 'command') {
          completion = `/${selectedSuggestion.value} `
        } else if (state.context.type === 'agent') {
          if (selectedSuggestion.type === 'agent') {
            completion = `@${selectedSuggestion.value} `
          } else if (selectedSuggestion.type === 'ask') {
            completion = `@${selectedSuggestion.value} `
          } else {
            // File reference in @mention context - always add space on Enter
            completion = `@${selectedSuggestion.value} `
          }
        } else if (selectedSuggestion.isSmartMatch) {
          // Smart match from normal input - add @ prefix
          completion = `@${selectedSuggestion.value} `
        } else {
          // Regular file completion - always add space on Enter
          completion = selectedSuggestion.value + ' '
        }
        
        // Apply completion with forced space
        const currentWord = input.slice(state.context.startPos)
        const nextSpaceIndex = currentWord.indexOf(' ')
        const actualEndPos = nextSpaceIndex === -1 ? input.length : state.context.startPos + nextSpaceIndex
        
        const newInput = input.slice(0, state.context.startPos) + completion + input.slice(actualEndPos)
        onInputChange(newInput)
        setCursorOffset(state.context.startPos + completion.length)
      }
      resetCompletion()
      return true
    }
    
    if (!state.isActive || state.suggestions.length === 0) return false
    
    // Arrow key navigation with preview
    const handleNavigation = (newIndex: number) => {
      const preview = state.suggestions[newIndex].value
      
      if (state.preview?.isActive && state.context) {
        const newInput = input.slice(0, state.context.startPos) + 
                         preview + 
                         input.slice(state.preview.wordRange[1])
        
        onInputChange(newInput)
        setCursorOffset(state.context.startPos + preview.length)
        
        updateState({
          selectedIndex: newIndex,
          preview: {
            ...state.preview,
            wordRange: [state.context.startPos, state.context.startPos + preview.length]
          }
        })
      } else {
        updateState({ selectedIndex: newIndex })
      }
    }
    
    if (key.downArrow) {
      const nextIndex = (state.selectedIndex + 1) % state.suggestions.length
      handleNavigation(nextIndex)
      return true
    }
    
    if (key.upArrow) {
      const nextIndex = state.selectedIndex === 0 
        ? state.suggestions.length - 1 
        : state.selectedIndex - 1
      handleNavigation(nextIndex)
      return true
    }
    
    // Space key - complete and potentially continue for directories
    if (inputChar === ' ' && state.isActive && state.suggestions.length > 0) {
      const selectedSuggestion = state.suggestions[state.selectedIndex]
      const isDirectory = selectedSuggestion.value.endsWith('/')
      
      if (!state.context) return false
      
      // Apply completion if needed
      const currentWordAtContext = input.slice(state.context.startPos, 
        state.context.startPos + selectedSuggestion.value.length)
      
      if (currentWordAtContext !== selectedSuggestion.value) {
        completeWith(selectedSuggestion, state.context)
      }
      
      resetCompletion()
      
      if (isDirectory) {
        // Continue completion for directories
        setTimeout(() => {
          const newContext = {
            ...state.context,
            prefix: selectedSuggestion.value,
            endPos: state.context.startPos + selectedSuggestion.value.length
          }
          
          const newSuggestions = generateSuggestions(newContext)
          
          if (newSuggestions.length > 0) {
            activateCompletion(newSuggestions, newContext)
          } else {
            updateState({
              emptyDirMessage: `Directory is empty: ${selectedSuggestion.value}`
            })
            setTimeout(() => updateState({ emptyDirMessage: '' }), 3000)
          }
        }, 50)
      }
      
      return true
    }
    
    // Right arrow key - same as space but different semantics
    if (key.rightArrow) {
      const selectedSuggestion = state.suggestions[state.selectedIndex]
      const isDirectory = selectedSuggestion.value.endsWith('/')
      
      if (!state.context) return false
      
      // Apply completion
      const currentWordAtContext = input.slice(state.context.startPos, 
        state.context.startPos + selectedSuggestion.value.length)
      
      if (currentWordAtContext !== selectedSuggestion.value) {
        completeWith(selectedSuggestion, state.context)
      }
      
      resetCompletion()
      
      if (isDirectory) {
        // Continue for directories
        setTimeout(() => {
          const newContext = {
            ...state.context,
            prefix: selectedSuggestion.value,
            endPos: state.context.startPos + selectedSuggestion.value.length
          }
          
          const newSuggestions = generateSuggestions(newContext)
          
          if (newSuggestions.length > 0) {
            activateCompletion(newSuggestions, newContext)
          } else {
            updateState({
              emptyDirMessage: `Directory is empty: ${selectedSuggestion.value}`
            })
            setTimeout(() => updateState({ emptyDirMessage: '' }), 3000)
          }
        }, 50)
      }
      
      return true
    }
    
    if (key.escape) {
      // Restore original text if in preview mode
      if (state.preview?.isActive && state.context) {
        onInputChange(state.preview.originalInput)
        setCursorOffset(state.context.startPos + state.context.prefix.length)
      }
      
      resetCompletion()
      return true
    }
    
    return false
  })

  // Handle delete/backspace keys - unified state management
  useInput((input_str, key) => {
    if (key.backspace || key.delete) {
      if (state.isActive) {
        resetCompletion()
        // Smart suppression based on input complexity
        const suppressionTime = input.length > 10 ? 200 : 100
        updateState({ 
          suppressUntil: Date.now() + suppressionTime
        })
        return true
      }
    }
    return false
  })

  // Input tracking with ref to avoid infinite loops
  const lastInputRef = useRef('')
  
  // Smart auto-triggering with cycle prevention
  useEffect(() => {
    // Prevent infinite loops by using ref
    if (lastInputRef.current === input) return
    
    const inputLengthChange = Math.abs(input.length - lastInputRef.current.length)
    const isHistoryNavigation = (
      inputLengthChange > 10 || // Large content change
      (inputLengthChange > 5 && !input.includes(lastInputRef.current.slice(-5))) // Different content
    ) && input !== lastInputRef.current
    
    // Update ref (no state update)
    lastInputRef.current = input
    
    // Skip if in preview mode or suppressed
    if (state.preview?.isActive || Date.now() < state.suppressUntil) {
      return
    }
    
    // Clear suggestions on history navigation
    if (isHistoryNavigation && state.isActive) {
      resetCompletion()
      return
    }
    
    const context = getWordAtCursor()
    
    if (context && shouldAutoTrigger(context)) {
      const newSuggestions = generateSuggestions(context)
      
      if (newSuggestions.length === 0) {
        resetCompletion()
      } else if (newSuggestions.length === 1 && shouldAutoHideSingleMatch(newSuggestions[0], context)) {
        resetCompletion() // Perfect match - hide
      } else {
        activateCompletion(newSuggestions, context)
      }
    } else if (state.context) {
      // Check if context changed significantly
      const contextChanged = !context ||
        state.context.type !== context.type ||
        state.context.startPos !== context.startPos ||
        !context.prefix.startsWith(state.context.prefix)
      
      if (contextChanged) {
        resetCompletion()
      }
    }
  }, [input, cursorOffset])

  // Smart triggering - only when it makes sense
  const shouldAutoTrigger = useCallback((context: CompletionContext): boolean => {
    switch (context.type) {
      case 'command':
        // Trigger immediately for slash commands
        return true
      case 'agent':
        // Trigger immediately for agent references
        return true  
      case 'file':
        // Be selective about file completion - avoid noise
        const prefix = context.prefix
        
        // Always trigger for clear path patterns
        if (prefix.startsWith('./') || prefix.startsWith('../') || 
            prefix.startsWith('/') || prefix.startsWith('~') || 
            prefix.includes('/')) {
          return true
        }
        
        // Trigger for single dot followed by something (like .g for .gitignore)
        if (prefix.startsWith('.') && prefix.length >= 2) {
          return true
        }
        
        // Skip very short prefixes that are likely code
        return false
      default:
        return false
    }
  }, [])

  // Helper function to determine if single suggestion should be auto-hidden
  const shouldAutoHideSingleMatch = useCallback((suggestion: UnifiedSuggestion, context: CompletionContext): boolean => {
    // Extract the actual typed input from context
    const currentInput = input.slice(context.startPos, context.endPos)
    // Check if should auto-hide single match
    
    // For files: more intelligent matching
    if (context.type === 'file') {
      // Special case: if suggestion is a directory (ends with /), don't auto-hide 
      // because user might want to continue navigating into it
      if (suggestion.value.endsWith('/')) {
        // Directory suggestion, keeping visible
        return false 
      }
      
      // Check exact match
      if (currentInput === suggestion.value) {
        // Exact match, hiding
        return true
      }
      
      // Check if current input is a complete file path and suggestion is just the filename
      // e.g., currentInput: "src/tools/ThinkTool/ThinkTool.tsx", suggestion: "ThinkTool.tsx"
      if (currentInput.endsWith('/' + suggestion.value) || currentInput.endsWith(suggestion.value)) {
        // Path ends with suggestion, hiding
        return true
      }
      
      return false
    }
    
    // For commands: check if /prefix exactly matches /command
    if (context.type === 'command') {
      const fullCommand = `/${suggestion.value}`
      const matches = currentInput === fullCommand
      // Check command match
      return matches
    }
    
    // For agents: check if @prefix exactly matches @agent-name
    if (context.type === 'agent') {
      const fullAgent = `@${suggestion.value}`
      const matches = currentInput === fullAgent
      // Check agent match
      return matches
    }
    
    return false
  }, [input])

  return {
    suggestions,
    selectedIndex,
    isActive,
    emptyDirMessage,
  }
}