import {
  Message as APIAssistantMessage,
  MessageParam,
  ToolUseBlock,
} from '@anthropic-ai/sdk/resources/index.mjs'
import type { UUID } from './types/common'
import type { Tool, ToolUseContext } from './Tool'
import {
  messagePairValidForBinaryFeedback,
  shouldUseBinaryFeedback,
} from './components/binary-feedback/utils.js'
import { CanUseToolFn } from './hooks/useCanUseTool'
import {
  formatSystemPromptWithContext,
  queryLLM,
  queryModel,
} from './services/claude.js'
import { emitReminderEvent } from './services/systemReminder'
import { logEvent } from './services/statsig'
import { all } from './utils/generators'
import { logError } from './utils/log'
import {
  debug as debugLogger,
  markPhase,
  getCurrentRequest,
  logUserFriendly,
} from './utils/debugLogger'
import { getModelManager } from './utils/model.js'
import {
  createAssistantMessage,
  createProgressMessage,
  createToolResultStopMessage,
  createUserMessage,
  FullToolUseResult,
  INTERRUPT_MESSAGE,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
  NormalizedMessage,
  normalizeMessagesForAPI,
} from './utils/messages.js'
import { createToolExecutionController } from './utils/toolExecutionController'
import { BashTool } from './tools/BashTool/BashTool'
import { getCwd } from './utils/state'
import { checkAutoCompact } from './utils/autoCompactCore'

// Extended ToolUseContext for query functions
interface ExtendedToolUseContext extends ToolUseContext {
  abortController: AbortController
  options: {
    commands: any[]
    forkNumber: number
    messageLogName: string
    tools: Tool[]
    verbose: boolean
    safeMode: boolean
    maxThinkingTokens: number
    isKodingRequest?: boolean
    model?: string | import('./utils/config').ModelPointerType
  }
  readFileTimestamps: { [filename: string]: number }
  setToolJSX: (jsx: any) => void
  requestId?: string
}

export type Response = { costUSD: number; response: string }
export type UserMessage = {
  message: MessageParam
  type: 'user'
  uuid: UUID
  toolUseResult?: FullToolUseResult
  options?: {
    isKodingRequest?: boolean
    kodingContext?: string
    isCustomCommand?: boolean
    commandName?: string
    commandArgs?: string
  }
}

export type AssistantMessage = {
  costUSD: number
  durationMs: number
  message: APIAssistantMessage
  type: 'assistant'
  uuid: UUID
  isApiErrorMessage?: boolean
  responseId?: string // For GPT-5 Responses API state management
}

export type BinaryFeedbackResult =
  | { message: AssistantMessage | null; shouldSkipPermissionCheck: false }
  | { message: AssistantMessage; shouldSkipPermissionCheck: true }

export type ProgressMessage = {
  content: AssistantMessage
  normalizedMessages: NormalizedMessage[]
  siblingToolUseIDs: Set<string>
  tools: Tool[]
  toolUseID: string
  type: 'progress'
  uuid: UUID
}

// Each array item is either a single message or a message-and-response pair
export type Message = UserMessage | AssistantMessage | ProgressMessage

const MAX_TOOL_USE_CONCURRENCY = 10

// Returns a message if we got one, or `null` if the user cancelled
async function queryWithBinaryFeedback(
  toolUseContext: ExtendedToolUseContext,
  getAssistantResponse: () => Promise<AssistantMessage>,
  getBinaryFeedbackResponse?: (
    m1: AssistantMessage,
    m2: AssistantMessage,
  ) => Promise<BinaryFeedbackResult>,
): Promise<BinaryFeedbackResult> {
  if (
    process.env.USER_TYPE !== 'ant' ||
    !getBinaryFeedbackResponse ||
    !(await shouldUseBinaryFeedback())
  ) {
    const assistantMessage = await getAssistantResponse()
    if (toolUseContext.abortController.signal.aborted) {
      return { message: null, shouldSkipPermissionCheck: false }
    }
    return { message: assistantMessage, shouldSkipPermissionCheck: false }
  }
  const [m1, m2] = await Promise.all([
    getAssistantResponse(),
    getAssistantResponse(),
  ])
  if (toolUseContext.abortController.signal.aborted) {
    return { message: null, shouldSkipPermissionCheck: false }
  }
  if (m2.isApiErrorMessage) {
    // If m2 is an error, we might as well return m1, even if it's also an error --
    // the UI will display it as an error as it would in the non-feedback path.
    return { message: m1, shouldSkipPermissionCheck: false }
  }
  if (m1.isApiErrorMessage) {
    return { message: m2, shouldSkipPermissionCheck: false }
  }
  if (!messagePairValidForBinaryFeedback(m1, m2)) {
    return { message: m1, shouldSkipPermissionCheck: false }
  }
  return await getBinaryFeedbackResponse(m1, m2)
}

/**
 * The rules of thinking are lengthy and fortuitous. They require plenty of thinking
 * of most long duration and deep meditation for a wizard to wrap one's noggin around.
 *
 * The rules follow:
 * 1. A message that contains a thinking or redacted_thinking block must be part of a query whose max_thinking_length > 0
 * 2. A thinking block may not be the last message in a block
 * 3. Thinking blocks must be preserved for the duration of an assistant trajectory (a single turn, or if that turn includes a tool_use block then also its subsequent tool_result and the following assistant message)
 *
 * Heed these rules well, young wizard. For they are the rules of thinking, and
 * the rules of thinking are the rules of the universe. If ye does not heed these
 * rules, ye will be punished with an entire day of debugging and hair pulling.
 */
export async function* query(
  messages: Message[],
  systemPrompt: string[],
  context: { [k: string]: string },
  canUseTool: CanUseToolFn,
  toolUseContext: ExtendedToolUseContext,
  getBinaryFeedbackResponse?: (
    m1: AssistantMessage,
    m2: AssistantMessage,
  ) => Promise<BinaryFeedbackResult>,
): AsyncGenerator<Message, void> {
  const currentRequest = getCurrentRequest()

  markPhase('QUERY_INIT')

  // Auto-compact check
  const { messages: processedMessages, wasCompacted } = await checkAutoCompact(
    messages,
    toolUseContext,
  )
  if (wasCompacted) {
    messages = processedMessages
  }

  markPhase('SYSTEM_PROMPT_BUILD')
  
  const { systemPrompt: fullSystemPrompt, reminders } =
    formatSystemPromptWithContext(systemPrompt, context, toolUseContext.agentId)

  // Emit session startup event
  emitReminderEvent('session:startup', {
    agentId: toolUseContext.agentId,
    messages: messages.length,
    timestamp: Date.now(),
  })

  // Inject reminders into the latest user message
  if (reminders && messages.length > 0) {
    // Find the last user message
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg?.type === 'user') {
        const lastUserMessage = msg as UserMessage
        messages[i] = {
          ...lastUserMessage,
          message: {
            ...lastUserMessage.message,
            content:
              typeof lastUserMessage.message.content === 'string'
                ? reminders + lastUserMessage.message.content
                : [
                    ...(Array.isArray(lastUserMessage.message.content)
                      ? lastUserMessage.message.content
                      : []),
                    { type: 'text', text: reminders },
                  ],
          },
        }
        break
      }
    }
  }

  markPhase('LLM_PREPARATION')

  function getAssistantResponse() {
    return queryLLM(
      normalizeMessagesForAPI(messages),
      fullSystemPrompt,
      toolUseContext.options.maxThinkingTokens,
      toolUseContext.options.tools,
      toolUseContext.abortController.signal,
      {
        safeMode: toolUseContext.options.safeMode ?? false,
        model: toolUseContext.options.model || 'main',
        prependCLISysprompt: true,
        toolUseContext: toolUseContext,
      },
    )
  }

  const result = await queryWithBinaryFeedback(
    toolUseContext,
    getAssistantResponse,
    getBinaryFeedbackResponse,
  )

  // If request was cancelled, return immediately with interrupt message  
  if (toolUseContext.abortController.signal.aborted) {
    yield createAssistantMessage(INTERRUPT_MESSAGE)
    return
  }

  if (result.message === null) {
    yield createAssistantMessage(INTERRUPT_MESSAGE)
    return
  }

  const assistantMessage = result.message
  const shouldSkipPermissionCheck = result.shouldSkipPermissionCheck

  yield assistantMessage

  // @see https://docs.anthropic.com/en/docs/build-with-claude/tool-use
  // Note: stop_reason === 'tool_use' is unreliable -- it's not always set correctly
  const toolUseMessages = assistantMessage.message.content.filter(
    _ => _.type === 'tool_use',
  )

  // If there's no more tool use, we're done
  if (!toolUseMessages.length) {
    return
  }

  const toolResults: UserMessage[] = []
  
  // Simple concurrency check like original system
  const canRunConcurrently = toolUseMessages.every(msg =>
    toolUseContext.options.tools.find(t => t.name === msg.name)?.isReadOnly(),
  )

  if (canRunConcurrently) {
    for await (const message of runToolsConcurrently(
      toolUseMessages,
      assistantMessage,
      canUseTool,
      toolUseContext,
      shouldSkipPermissionCheck,
    )) {
      yield message
      // progress messages are not sent to the server, so don't need to be accumulated for the next turn
      if (message.type === 'user') {
        toolResults.push(message)
      }
    }
  } else {
    for await (const message of runToolsSerially(
      toolUseMessages,
      assistantMessage,
      canUseTool,
      toolUseContext,
      shouldSkipPermissionCheck,
    )) {
      yield message
      // progress messages are not sent to the server, so don't need to be accumulated for the next turn
      if (message.type === 'user') {
        toolResults.push(message)
      }
    }
  }

  if (toolUseContext.abortController.signal.aborted) {
    yield createAssistantMessage(INTERRUPT_MESSAGE_FOR_TOOL_USE)
    return
  }

  // Sort toolResults to match the order of toolUseMessages
  const orderedToolResults = toolResults.sort((a, b) => {
    const aIndex = toolUseMessages.findIndex(
      tu => tu.id === (a.message.content[0] as ToolUseBlock).id,
    )
    const bIndex = toolUseMessages.findIndex(
      tu => tu.id === (b.message.content[0] as ToolUseBlock).id,
    )
    return aIndex - bIndex
  })

  // Recursive query

  try {
    yield* await query(
      [...messages, assistantMessage, ...orderedToolResults],
      systemPrompt,
      context,
      canUseTool,
      toolUseContext,
      getBinaryFeedbackResponse,
    )
  } catch (error) {
    // Re-throw the error to maintain the original behavior
    throw error
  }
}

async function* runToolsConcurrently(
  toolUseMessages: ToolUseBlock[],
  assistantMessage: AssistantMessage,
  canUseTool: CanUseToolFn,
  toolUseContext: ExtendedToolUseContext,
  shouldSkipPermissionCheck?: boolean,
): AsyncGenerator<Message, void> {
  yield* all(
    toolUseMessages.map(toolUse =>
      runToolUse(
        toolUse,
        new Set(toolUseMessages.map(_ => _.id)),
        assistantMessage,
        canUseTool,
        toolUseContext,
        shouldSkipPermissionCheck,
      ),
    ),
    MAX_TOOL_USE_CONCURRENCY,
  )
}

async function* runToolsSerially(
  toolUseMessages: ToolUseBlock[],
  assistantMessage: AssistantMessage,
  canUseTool: CanUseToolFn,
  toolUseContext: ExtendedToolUseContext,
  shouldSkipPermissionCheck?: boolean,
): AsyncGenerator<Message, void> {
  for (const toolUse of toolUseMessages) {
    yield* runToolUse(
      toolUse,
      new Set(toolUseMessages.map(_ => _.id)),
      assistantMessage,
      canUseTool,
      toolUseContext,
      shouldSkipPermissionCheck,
    )
  }
}

export async function* runToolUse(
  toolUse: ToolUseBlock,
  siblingToolUseIDs: Set<string>,
  assistantMessage: AssistantMessage,
  canUseTool: CanUseToolFn,
  toolUseContext: ExtendedToolUseContext,
  shouldSkipPermissionCheck?: boolean,
): AsyncGenerator<Message, void> {
  const currentRequest = getCurrentRequest()

  // 🔍 Debug: 工具调用开始
  debugLogger.flow('TOOL_USE_START', {
    toolName: toolUse.name,
    toolUseID: toolUse.id,
    inputSize: JSON.stringify(toolUse.input).length,
    siblingToolCount: siblingToolUseIDs.size,
    shouldSkipPermissionCheck: !!shouldSkipPermissionCheck,
    requestId: currentRequest?.id,
  })

  logUserFriendly(
    'TOOL_EXECUTION',
    {
      toolName: toolUse.name,
      action: 'Starting',
      target: toolUse.input ? Object.keys(toolUse.input).join(', ') : '',
    },
    currentRequest?.id,
  )


  logEvent('tengu_tool_use_start', {
    toolName: toolUse.name,
    toolUseID: toolUse.id,
  })

  const toolName = toolUse.name
  const tool = toolUseContext.options.tools.find(t => t.name === toolName)

  // Check if the tool exists
  if (!tool) {
    debugLogger.error('TOOL_NOT_FOUND', {
      requestedTool: toolName,
      availableTools: toolUseContext.options.tools.map(t => t.name),
      toolUseID: toolUse.id,
      requestId: currentRequest?.id,
    })

    logEvent('tengu_tool_use_error', {
      error: `No such tool available: ${toolName}`,
      messageID: assistantMessage.message.id,
      toolName,
      toolUseID: toolUse.id,
    })

    yield createUserMessage([
      {
        type: 'tool_result',
        content: `Error: No such tool available: ${toolName}`,
        is_error: true,
        tool_use_id: toolUse.id,
      },
    ])
    return
  }

  const toolInput = toolUse.input as { [key: string]: string }

  debugLogger.flow('TOOL_VALIDATION_START', {
    toolName: tool.name,
    toolUseID: toolUse.id,
    inputKeys: Object.keys(toolInput),
    requestId: currentRequest?.id,
  })

  try {
    // 🔧 Check for cancellation before starting tool execution
    if (toolUseContext.abortController.signal.aborted) {
      debugLogger.flow('TOOL_USE_CANCELLED_BEFORE_START', {
        toolName: tool.name,
        toolUseID: toolUse.id,
        abortReason: 'AbortController signal',
        requestId: currentRequest?.id,
      })

      logEvent('tengu_tool_use_cancelled', {
        toolName: tool.name,
        toolUseID: toolUse.id,
      })

      const message = createUserMessage([
        createToolResultStopMessage(toolUse.id),
      ])
      yield message
      return
    }

    // Track if any progress messages were yielded
    let hasProgressMessages = false
    
    for await (const message of checkPermissionsAndCallTool(
      tool,
      toolUse.id,
      siblingToolUseIDs,
      toolInput,
      toolUseContext,
      canUseTool,
      assistantMessage,
      shouldSkipPermissionCheck,
    )) {
      // 🔧 Check for cancellation during tool execution
      if (toolUseContext.abortController.signal.aborted) {
        debugLogger.flow('TOOL_USE_CANCELLED_DURING_EXECUTION', {
          toolName: tool.name,
          toolUseID: toolUse.id,
          hasProgressMessages,
          abortReason: 'AbortController signal during execution',
          requestId: currentRequest?.id,
        })

        // If we yielded progress messages but got cancelled, yield a cancellation result
        if (hasProgressMessages && message.type === 'progress') {
          yield message // yield the last progress message first
        }
        
        // Always yield a tool result message for cancellation to clear UI state
        const cancelMessage = createUserMessage([
          createToolResultStopMessage(toolUse.id),
        ])
        yield cancelMessage
        return
      }

      if (message.type === 'progress') {
        hasProgressMessages = true
      }
      
      yield message
    }
  } catch (e) {
    logError(e)
    
    // 🔧 Even on error, ensure we yield a tool result to clear UI state
    const errorMessage = createUserMessage([
      {
        type: 'tool_result',
        content: `Tool execution failed: ${e instanceof Error ? e.message : String(e)}`,
        is_error: true,
        tool_use_id: toolUse.id,
      },
    ])
    yield errorMessage
  }
}

// TODO: Generalize this to all tools
export function normalizeToolInput(
  tool: Tool,
  input: { [key: string]: boolean | string | number },
): { [key: string]: boolean | string | number } {
  switch (tool) {
    case BashTool: {
      const { command, timeout } = BashTool.inputSchema.parse(input) // already validated upstream, won't throw
      return {
        command: command.replace(`cd ${getCwd()} && `, ''),
        ...(timeout ? { timeout } : {}),
      }
    }
    default:
      return input
  }
}

async function* checkPermissionsAndCallTool(
  tool: Tool,
  toolUseID: string,
  siblingToolUseIDs: Set<string>,
  input: { [key: string]: boolean | string | number },
  context: ToolUseContext,
  canUseTool: CanUseToolFn,
  assistantMessage: AssistantMessage,
  shouldSkipPermissionCheck?: boolean,
): AsyncGenerator<UserMessage | ProgressMessage, void> {
  // Validate input types with zod
  // (surprisingly, the model is not great at generating valid input)
  const isValidInput = tool.inputSchema.safeParse(input)
  if (!isValidInput.success) {
    // Create a more helpful error message for common cases
    let errorMessage = `InputValidationError: ${isValidInput.error.message}`
    
    // Special handling for the "View" tool (FileReadTool) being called with empty parameters
    if (tool.name === 'View' && Object.keys(input).length === 0) {
      errorMessage = `Error: The View tool requires a 'file_path' parameter to specify which file to read. Please provide the absolute path to the file you want to view. For example: {"file_path": "/path/to/file.txt"}`
    }
    
    logEvent('tengu_tool_use_error', {
      error: errorMessage,
      messageID: assistantMessage.message.id,
      toolName: tool.name,
      toolInput: JSON.stringify(input).slice(0, 200),
    })
    yield createUserMessage([
      {
        type: 'tool_result',
        content: errorMessage,
        is_error: true,
        tool_use_id: toolUseID,
      },
    ])
    return
  }

  const normalizedInput = normalizeToolInput(tool, input)

  // Validate input values. Each tool has its own validation logic
  const isValidCall = await tool.validateInput?.(
    normalizedInput as never,
    context,
  )
  if (isValidCall?.result === false) {
    logEvent('tengu_tool_use_error', {
      error: isValidCall?.message.slice(0, 2000),
      messageID: assistantMessage.message.id,
      toolName: tool.name,
      toolInput: JSON.stringify(input).slice(0, 200),
      ...(isValidCall?.meta ?? {}),
    })
    yield createUserMessage([
      {
        type: 'tool_result',
        content: isValidCall!.message,
        is_error: true,
        tool_use_id: toolUseID,
      },
    ])
    return
  }

  // Check whether we have permission to use the tool,
  // and ask the user for permission if we don't
  const permissionResult = shouldSkipPermissionCheck
    ? ({ result: true } as const)
    : await canUseTool(tool, normalizedInput, context, assistantMessage)
  if (permissionResult.result === false) {
    yield createUserMessage([
      {
        type: 'tool_result',
        content: permissionResult.message,
        is_error: true,
        tool_use_id: toolUseID,
      },
    ])
    return
  }

  // Call the tool
  try {
    const generator = tool.call(normalizedInput as never, context)
    for await (const result of generator) {
      switch (result.type) {
        case 'result':
          logEvent('tengu_tool_use_success', {
            messageID: assistantMessage.message.id,
            toolName: tool.name,
          })
          yield createUserMessage(
            [
              {
                type: 'tool_result',
                content: result.resultForAssistant || String(result.data),
                tool_use_id: toolUseID,
              },
            ],
            {
              data: result.data,
              resultForAssistant: result.resultForAssistant || String(result.data),
            },
          )
          return
        case 'progress':
          logEvent('tengu_tool_use_progress', {
            messageID: assistantMessage.message.id,
            toolName: tool.name,
          })
          yield createProgressMessage(
            toolUseID,
            siblingToolUseIDs,
            result.content,
            result.normalizedMessages || [],
            result.tools || [],
          )
          break
      }
    }
  } catch (error) {
    const content = formatError(error)
    logError(error)
    logEvent('tengu_tool_use_error', {
      error: content.slice(0, 2000),
      messageID: assistantMessage.message.id,
      toolName: tool.name,
      toolInput: JSON.stringify(input).slice(0, 1000),
    })
    yield createUserMessage([
      {
        type: 'tool_result',
        content,
        is_error: true,
        tool_use_id: toolUseID,
      },
    ])
  }
}

function formatError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error)
  }
  const parts = [error.message]
  if ('stderr' in error && typeof error.stderr === 'string') {
    parts.push(error.stderr)
  }
  if ('stdout' in error && typeof error.stdout === 'string') {
    parts.push(error.stdout)
  }
  const fullMessage = parts.filter(Boolean).join('\n')
  if (fullMessage.length <= 10000) {
    return fullMessage
  }
  const halfLength = 5000
  const start = fullMessage.slice(0, halfLength)
  const end = fullMessage.slice(-halfLength)
  return `${start}\n\n... [${fullMessage.length - 10000} characters truncated] ...\n\n${end}`
}
