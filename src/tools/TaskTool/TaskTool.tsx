import { TextBlock } from '@anthropic-ai/sdk/resources/index.mjs'
import chalk from 'chalk'
import { last, memoize } from 'lodash-es'
import { EOL } from 'os'
import React, { useState, useEffect } from 'react'
import { Box, Text } from 'ink'
import { z } from 'zod'
import { Tool, ValidationResult } from '../../Tool'
import { FallbackToolUseRejectedMessage } from '../../components/FallbackToolUseRejectedMessage'
import { getAgentPrompt } from '../../constants/prompts'
import { getContext } from '../../context'
import { hasPermissionsToUseTool } from '../../permissions'
import { AssistantMessage, Message as MessageType, query } from '../../query'
import { formatDuration, formatNumber } from '../../utils/format'
import {
  getMessagesPath,
  getNextAvailableLogSidechainNumber,
  overwriteLog,
} from '../../utils/log.js'
import { applyMarkdown } from '../../utils/markdown'
import {
  createAssistantMessage,
  createUserMessage,
  getLastAssistantMessageId,
  INTERRUPT_MESSAGE,
  normalizeMessages,
} from '../../utils/messages.js'
import { getModelManager } from '../../utils/model'
import { getMaxThinkingTokens } from '../../utils/thinking'
import { getTheme } from '../../utils/theme'
import { generateAgentId } from '../../utils/agentStorage'
import { debug as debugLogger } from '../../utils/debugLogger'
import { getTaskTools, getPrompt } from './prompt'
import { TOOL_NAME } from './constants'
import { getActiveAgents, getAgentByType, getAvailableAgentTypes } from '../../utils/agentLoader'

const inputSchema = z.object({
  description: z
    .string()
    .describe('A short (3-5 word) description of the task'),
  prompt: z.string().describe('The task for the agent to perform'),
  model_name: z
    .string()
    .optional()
    .describe(
      'Optional: Specific model name to use for this task. If not provided, uses the default task model pointer.',
    ),
  subagent_type: z
    .string()
    .optional()
    .describe(
      'The type of specialized agent to use for this task',
    ),
})

export const TaskTool = {
  async prompt({ safeMode }) {
    // Match original Claude Code - prompt returns full agent descriptions
    return await getPrompt(safeMode)
  },
  name: TOOL_NAME,
  async description() {
    // Match original Claude Code exactly - simple description
    return "Launch a new task"
  },
  inputSchema,
  
  async *call(
    { description, prompt, model_name, subagent_type },
    {
      abortController,
      options: { safeMode = false, forkNumber, messageLogName, verbose },
      readFileTimestamps,
    },
  ): AsyncGenerator<{ type: 'result'; data: TextBlock[]; resultForAssistant?: string }, void, unknown> {
    const startTime = Date.now()
    
    // Default to general-purpose if no subagent_type specified
    const agentType = subagent_type || 'general-purpose'
    
    // Apply subagent configuration
    let effectivePrompt = prompt
    let effectiveModel = model_name || 'task'
    let toolFilter = null
    let temperature = undefined
    
    // Load agent configuration dynamically
    if (agentType) {
      const agentConfig = await getAgentByType(agentType)
      
      if (!agentConfig) {
        // If agent type not found, return helpful message instead of throwing
        const availableTypes = await getAvailableAgentTypes()
        const helpMessage = `Agent type '${agentType}' not found.\n\nAvailable agents:\n${availableTypes.map(t => `  • ${t}`).join('\n')}\n\nUse /agents command to manage agent configurations.`
        
        yield {
          type: 'result',
          data: [{ type: 'text', text: helpMessage }] as TextBlock[],
          resultForAssistant: helpMessage,
        }
        return
      }
      
      // Apply system prompt if configured
      if (agentConfig.systemPrompt) {
        effectivePrompt = `${agentConfig.systemPrompt}\n\n${prompt}`
      }
      
      // Apply model if not overridden by model_name parameter
      if (!model_name && agentConfig.model_name) {
        // Support inherit: keep pointer-based default
        if (agentConfig.model_name !== 'inherit') {
          effectiveModel = agentConfig.model_name as string
        }
      }
      
      // Store tool filter for later application
      toolFilter = agentConfig.tools
      
      // Note: temperature is not currently in our agent configs
      // but could be added in the future
    }
    
    const messages: MessageType[] = [createUserMessage(effectivePrompt)]
    let tools = await getTaskTools(safeMode)
    
    // Apply tool filtering if specified by subagent config
    if (toolFilter) {
      // Back-compat: ['*'] means all tools
      const isAllArray = Array.isArray(toolFilter) && toolFilter.length === 1 && toolFilter[0] === '*'
      if (toolFilter === '*' || isAllArray) {
        // no-op, keep all tools
      } else if (Array.isArray(toolFilter)) {
        tools = tools.filter(tool => toolFilter.includes(tool.name))
      }
    }

    // Skip initial progress yield - only yield results for Tool interface

    const [taskPrompt, context, maxThinkingTokens] = await Promise.all([
      getAgentPrompt(),
      getContext(),
      getMaxThinkingTokens(messages),
    ])

    // Model already resolved in effectiveModel variable above
    const modelToUse = effectiveModel
    
    // Inject model context to prevent self-referential expert consultations
    taskPrompt.push(`\nIMPORTANT: You are currently running as ${modelToUse}. You do not need to consult ${modelToUse} via AskExpertModel since you ARE ${modelToUse}. Complete tasks directly using your capabilities.`)

    let toolUseCount = 0

    const getSidechainNumber = memoize(() =>
      getNextAvailableLogSidechainNumber(messageLogName, forkNumber),
    )

    // Generate unique Task ID for this task execution
    const taskId = generateAgentId()

    // 🔧 ULTRA SIMPLIFIED: Exact original AgentTool pattern
    // Build query options, adding temperature if specified
    const queryOptions = {
      safeMode,
      forkNumber,
      messageLogName,
      tools,
      commands: [],
      verbose,
      maxThinkingTokens,
      model: modelToUse,
    }
    
    // Add temperature if specified by subagent config
    if (temperature !== undefined) {
      queryOptions['temperature'] = temperature
    }
    
    for await (const message of query(
      messages,
      taskPrompt,
      context,
      hasPermissionsToUseTool,
      {
        abortController,
        options: queryOptions,
        messageId: getLastAssistantMessageId(messages),
        agentId: taskId,
        readFileTimestamps,
        setToolJSX: () => {}, // No-op implementation for TaskTool
      },
    )) {
      messages.push(message)

      overwriteLog(
        getMessagesPath(messageLogName, forkNumber, getSidechainNumber()),
        messages.filter(_ => _.type !== 'progress'),
      )

      if (message.type !== 'assistant') {
        continue
      }

      const normalizedMessages = normalizeMessages(messages)
      
      // Process tool uses and text content for better visibility
      for (const content of message.message.content) {
        if (content.type === 'text' && content.text && content.text !== INTERRUPT_MESSAGE) {
          // Show agent's reasoning/responses
          const preview = content.text.length > 200 ? content.text.substring(0, 200) + '...' : content.text
          // Skip progress yield - only yield results for Tool interface
        } else if (content.type === 'tool_use') {
          toolUseCount++
          
          // Show which tool is being used with agent context
          const toolMessage = normalizedMessages.find(
            _ =>
              _.type === 'assistant' &&
              _.message.content[0]?.type === 'tool_use' &&
              _.message.content[0].id === content.id,
          ) as AssistantMessage
          
          if (toolMessage) {
            // Clone and modify the message to show agent context
            const modifiedMessage = {
              ...toolMessage,
              message: {
                ...toolMessage.message,
                content: toolMessage.message.content.map(c => {
                  if (c.type === 'tool_use' && c.id === content.id) {
                    // Add agent context to tool name display
                    return {
                      ...c,
                      name: c.name // Keep original name, UI will handle display
                    }
                  }
                  return c
                })
              }
            }
            
            // Skip progress yield - only yield results for Tool interface
          }
        }
      }
    }

    const normalizedMessages = normalizeMessages(messages)
    const lastMessage = last(messages)
    if (lastMessage?.type !== 'assistant') {
      throw new Error('Last message was not an assistant message')
    }

    // 🔧 CRITICAL FIX: Match original AgentTool interrupt handling pattern exactly
    if (
      lastMessage.message.content.some(
        _ => _.type === 'text' && _.text === INTERRUPT_MESSAGE,
      )
    ) {
      // Skip progress yield - only yield final result
    } else {
      const result = [
        toolUseCount === 1 ? '1 tool use' : `${toolUseCount} tool uses`,
        formatNumber(
          (lastMessage.message.usage.cache_creation_input_tokens ?? 0) +
            (lastMessage.message.usage.cache_read_input_tokens ?? 0) +
            lastMessage.message.usage.input_tokens +
            lastMessage.message.usage.output_tokens,
        ) + ' tokens',
        formatDuration(Date.now() - startTime),
      ]
      // Skip progress yield - only yield final result
    }

    // Output is an AssistantMessage, but since TaskTool is a tool, it needs
    // to serialize its response to UserMessage-compatible content.
    const data = lastMessage.message.content.filter(_ => _.type === 'text')
    yield {
      type: 'result',
      data,
      resultForAssistant: this.renderResultForAssistant(data),
    }
  },

  isReadOnly() {
    return true // for now...
  },
  isConcurrencySafe() {
    return true // Task tool supports concurrent execution in official implementation
  },
  async validateInput(input, context) {
    if (!input.description || typeof input.description !== 'string') {
      return {
        result: false,
        message: 'Description is required and must be a string',
      }
    }
    if (!input.prompt || typeof input.prompt !== 'string') {
      return {
        result: false,
        message: 'Prompt is required and must be a string',
      }
    }

    // Model validation - similar to Edit tool error handling
    if (input.model_name) {
      const modelManager = getModelManager()
      const availableModels = modelManager.getAllAvailableModelNames()

      if (!availableModels.includes(input.model_name)) {
        return {
          result: false,
          message: `Model '${input.model_name}' does not exist. Available models: ${availableModels.join(', ')}`,
          meta: {
            model_name: input.model_name,
            availableModels,
          },
        }
      }
    }

    // Validate subagent_type if provided
    if (input.subagent_type) {
      const availableTypes = await getAvailableAgentTypes()
      if (!availableTypes.includes(input.subagent_type)) {
        return {
          result: false,
          message: `Agent type '${input.subagent_type}' does not exist. Available types: ${availableTypes.join(', ')}`,
          meta: {
            subagent_type: input.subagent_type,
            availableTypes,
          },
        }
      }
    }

    return { result: true }
  },
  async isEnabled() {
    return true
  },
  userFacingName(input?: any) {
    // Return agent name with proper prefix
    const agentType = input?.subagent_type || 'general-purpose'
    return `agent-${agentType}`
  },
  needsPermissions() {
    return false
  },
  renderResultForAssistant(data: TextBlock[]) {
    return data.map(block => block.type === 'text' ? block.text : '').join('\n')
  },
  renderToolUseMessage({ description, prompt, model_name, subagent_type }, { verbose }) {
    if (!description || !prompt) return null

    const modelManager = getModelManager()
    const defaultTaskModel = modelManager.getModelName('task')
    const actualModel = model_name || defaultTaskModel
    const agentType = subagent_type || 'general-purpose'
    const promptPreview =
      prompt.length > 80 ? prompt.substring(0, 80) + '...' : prompt

    const theme = getTheme()
    
    if (verbose) {
      return (
        <Box flexDirection="column">
          <Text>
            [{agentType}] {actualModel}: {description}
          </Text>
          <Box
            paddingLeft={2}
            borderLeftStyle="single"
            borderLeftColor={theme.secondaryBorder}
          >
            <Text color={theme.secondaryText}>{promptPreview}</Text>
          </Box>
        </Box>
      )
    }

    // Simple display: agent type, model and description
    return `[${agentType}] ${actualModel}: ${description}`
  },
  renderToolUseRejectedMessage() {
    return <FallbackToolUseRejectedMessage />
  },
  renderToolResultMessage(content) {
    const theme = getTheme()

    if (Array.isArray(content)) {
      const textBlocks = content.filter(block => block.type === 'text')
      const totalLength = textBlocks.reduce(
        (sum, block) => sum + block.text.length,
        0,
      )
      // 🔧 CRITICAL FIX: Use exact match for interrupt detection, not .includes()
      const isInterrupted = content.some(
        block =>
          block.type === 'text' && block.text === INTERRUPT_MESSAGE,
      )

      if (isInterrupted) {
        // 🔧 CRITICAL FIX: Match original system interrupt rendering exactly
        return (
          <Box flexDirection="row">
            <Text>&nbsp;&nbsp;⎿ &nbsp;</Text>
            <Text color={theme.error}>Interrupted by user</Text>
          </Box>
        )
      }

      return (
        <Box flexDirection="column">
          <Box justifyContent="space-between" width="100%">
            <Box flexDirection="row">
              <Text>&nbsp;&nbsp;⎿ &nbsp;</Text>
              <Text>Task completed</Text>
              {textBlocks.length > 0 && (
                <Text color={theme.secondaryText}>
                  {' '}
                  ({totalLength} characters)
                </Text>
              )}
            </Box>
          </Box>
        </Box>
      )
    }

    return (
      <Box flexDirection="row">
        <Text>&nbsp;&nbsp;⎿ &nbsp;</Text>
        <Text color={theme.secondaryText}>Task completed</Text>
      </Box>
    )
  },
} satisfies Tool<typeof inputSchema, TextBlock[]>
