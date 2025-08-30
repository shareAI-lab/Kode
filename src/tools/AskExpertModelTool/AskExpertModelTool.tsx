import * as React from 'react'
import { Box, Text } from 'ink'
import { z } from 'zod'
import { Tool, ValidationResult } from '../../Tool'
import { FallbackToolUseRejectedMessage } from '../../components/FallbackToolUseRejectedMessage'
import { getModelManager } from '../../utils/model'
import { getTheme } from '../../utils/theme'
import {
  createUserMessage,
  createAssistantMessage,
  INTERRUPT_MESSAGE,
} from '../../utils/messages'
import { logError } from '../../utils/log'
import {
  createExpertChatSession,
  loadExpertChatSession,
  getSessionMessages,
  addMessageToSession,
} from '../../utils/expertChatStorage'
import { queryLLM } from '../../services/claude'
import { debug as debugLogger } from '../../utils/debugLogger'
import { applyMarkdown } from '../../utils/markdown'

export const inputSchema = z.strictObject({
  question: z.string().describe(
    'COMPLETE SELF-CONTAINED QUESTION: Must include full background context, relevant details, and a clear independent question. The expert model will receive ONLY this content with no access to previous conversation or external context. Structure as: 1) Background/Context 2) Specific situation/problem 3) Clear question. Ensure the expert can fully understand and respond without needing additional information.'
  ),
  expert_model: z
    .string()
    .describe(
      'The expert model to use (e.g., gpt-5, claude-3-5-sonnet-20241022)',
    ),
  chat_session_id: z
    .string()
    .describe(
      'Chat session ID: use "new" for new session or existing session ID',
    ),
})

type In = typeof inputSchema
export type Out = {
  chatSessionId: string
  expertModelName: string
  expertAnswer: string
}

export const AskExpertModelTool = {
  name: 'AskExpertModel',
  async description() {
    return "Consult external AI models for expert opinions and analysis"
  },
  async prompt() {
    return `Ask a question to a specific external AI model for expert analysis.

This tool allows you to consult different AI models for their unique perspectives and expertise.

CRITICAL REQUIREMENT FOR QUESTION PARAMETER:
The question MUST be completely self-contained and include:
1. FULL BACKGROUND CONTEXT - All relevant information the expert needs
2. SPECIFIC SITUATION - Clear description of the current scenario/problem
3. INDEPENDENT QUESTION - What exactly you want the expert to analyze/answer

The expert model receives ONLY your question content with NO access to:
- Previous conversation history (unless using existing session)  
- Current codebase or file context
- User's current task or project details

IMPORTANT: This tool is for asking questions to models, not for task execution.
- Use when you need a specific model's opinion or analysis
- Use when you want to compare different models' responses
- Use the @ask-[model] format when available

The expert_model parameter accepts:
- OpenAI: gpt-4, gpt-5, o1-preview
- Anthropic: claude-3-5-sonnet, claude-3-opus  
- Others: kimi, gemini-pro, mixtral

Example of well-structured question:
"Background: I'm working on a React TypeScript application with performance issues. The app renders a large list of 10,000 items using a simple map() function, causing UI freezing.

Current situation: Users report 3-5 second delays when scrolling through the list. The component re-renders the entire list on every state change.

Question: What are the most effective React optimization techniques for handling large lists, and how should I prioritize implementing virtualization vs memoization vs other approaches?"`
  },
  isReadOnly() {
    return true
  },
  isConcurrencySafe() {
    return true
  },
  inputSchema,
  userFacingName() {
    return 'AskExpertModel'
  },
  async isEnabled() {
    return true
  },
  needsPermissions(): boolean {
    return false
  },
  async validateInput({
    question,
    expert_model,
    chat_session_id,
  }, context?: any): Promise<ValidationResult> {
    if (!question.trim()) {
      return { result: false, message: 'Question cannot be empty' }
    }


    if (!expert_model.trim()) {
      return { result: false, message: 'Expert model must be specified' }
    }

    if (!chat_session_id.trim()) {
      return {
        result: false,
        message:
          'Chat session ID must be specified (use "new" for new session)',
      }
    }

    // Check if trying to consult the same model we're currently running
    try {
      const modelManager = getModelManager()
      
      // Get current model based on context
      let currentModel: string
      if (context?.agentId && context?.options?.model) {
        // In subagent context (Task tool)
        currentModel = context.options.model
      } else {
        // In main agent context or after model switch
        currentModel = modelManager.getModelName('main') || ''
      }
      
      // Normalize model names for comparison
      const normalizedExpert = expert_model.toLowerCase().replace(/[^a-z0-9]/g, '')
      const normalizedCurrent = currentModel.toLowerCase().replace(/[^a-z0-9]/g, '')
      
      if (normalizedExpert === normalizedCurrent) {
        return {
          result: false,
          message: `You are already running as ${currentModel}. Consulting the same model would be redundant. Please choose a different model or handle the task directly.`
        }
      }
    } catch (e) {
      // If we can't determine current model, allow the request
      debugLogger.error('AskExpertModel', { message: 'Could not determine current model', error: e })
    }

    // Validate that the model exists and is available
    try {
      const modelManager = getModelManager()
      const modelResolution = modelManager.resolveModelWithInfo(expert_model)

      if (!modelResolution.success) {
        const availableModels = modelManager.getAllAvailableModelNames()
        if (availableModels.length > 0) {
          return {
            result: false,
            message: `Model '${expert_model}' is not configured. Available models: ${availableModels.join(', ')}. Check if any available model closely matches the user's request (e.g., 'kimi' matches 'kimi-k2-0711-preview'). If there's a strong match, auto retry using the correct model name. If no close match exists, inform the user that '${expert_model}' needs to be configured using /model command.`,
          }
        } else {
          return {
            result: false,
            message: `Model '${expert_model}' not found and no models are currently configured in the system. Inform the user that models need to be configured first using the /model command.`,
          }
        }
      }
    } catch (error) {
      console.error('Model validation error in AskExpertModelTool:', error)
      logError(error)
      return {
        result: false,
        message: `Failed to validate expert model '${expert_model}'. Please check your model configuration.`,
      }
    }

    return { result: true }
  },

  renderToolUseMessage(
    { question, expert_model, chat_session_id },
    { verbose },
  ) {
    if (!question || !expert_model) return null
    const isNewSession = chat_session_id === 'new'
    const sessionDisplay = isNewSession ? 'new session' : `session ${chat_session_id.substring(0, 5)}...`
    const theme = getTheme()

    if (verbose) {
      return (
        <Box flexDirection="column">
          <Text bold color="yellow">{expert_model}</Text>
          <Text color={theme.secondaryText}>{sessionDisplay}</Text>
          <Box marginTop={1}>
            <Text color={theme.text}>
              {question.length > 300 ? question.substring(0, 300) + '...' : question}
            </Text>
          </Box>
        </Box>
      )
    }
    return (
      <Box flexDirection="column">
        <Text bold color="yellow">{expert_model} </Text>
        <Text color={theme.secondaryText} dimColor>({sessionDisplay})</Text>
      </Box>
    )
  },

  renderToolResultMessage(content) {
    const verbose = true // Show more content
    const theme = getTheme()

    if (typeof content === 'object' && content && 'expertAnswer' in content) {
      const expertResult = content as Out
      const isError = expertResult.expertAnswer.startsWith('Error') || expertResult.expertAnswer.includes('failed')
      const isInterrupted = expertResult.chatSessionId === 'interrupted'

      if (isInterrupted) {
        return (
          <Box flexDirection="row">
            <Text color={theme.secondaryText}>Consultation interrupted</Text>
          </Box>
        )
      }

      const answerText = verbose 
        ? expertResult.expertAnswer.trim()
        : expertResult.expertAnswer.length > 500
          ? expertResult.expertAnswer.substring(0, 500) + '...'
          : expertResult.expertAnswer.trim()

      if (isError) {
        return (
          <Box flexDirection="column">
            <Text color="red">{answerText}</Text>
          </Box>
        )
      }

      return (
        <Box flexDirection="column">
          <Text bold color={theme.text}>Response from {expertResult.expertModelName}:</Text>
          <Box marginTop={1}>
            <Text color={theme.text}>
              {applyMarkdown(answerText)}
            </Text>
          </Box>
          <Box marginTop={1}>
            <Text color={theme.secondaryText} dimColor>
              Session: {expertResult.chatSessionId.substring(0, 8)}
            </Text>
          </Box>
        </Box>
      )
    }

    return (
      <Box flexDirection="row">
        <Text color={theme.secondaryText}>Consultation completed</Text>
      </Box>
    )
  },

  renderResultForAssistant(output: Out): string {
    return `[Expert consultation completed]
Expert Model: ${output.expertModelName}
Session ID: ${output.chatSessionId}
To continue this conversation with context preservation, use this Session ID in your next AskExpertModel call to maintain the full conversation history and context.

${output.expertAnswer}`
  },

  renderToolUseRejectedMessage() {
    return <FallbackToolUseRejectedMessage />
  },

  async *call(
    { question, expert_model, chat_session_id },
    { abortController, readFileTimestamps },
  ) {
    const expertModel = expert_model

    let sessionId: string
    let isInterrupted = false

    // Set up abort listener (following TaskTool pattern)
    const abortListener = () => {
      isInterrupted = true
    }
    abortController.signal.addEventListener('abort', abortListener)

    try {
      // Initial abort check
      if (abortController.signal.aborted) {
        return yield* this.handleInterrupt()
      }
      // Session management with error handling
      if (chat_session_id === 'new') {
        try {
          const session = createExpertChatSession(expertModel)
          sessionId = session.sessionId
        } catch (error) {
          console.error('Failed to create new expert chat session:', error)
          logError(error)
          throw new Error('Failed to create new chat session')
        }
      } else {
        sessionId = chat_session_id
        try {
          const session = loadExpertChatSession(sessionId)
          if (!session) {
            // Session doesn't exist, create new one
            const newSession = createExpertChatSession(expertModel)
            sessionId = newSession.sessionId
          }
        } catch (error) {
          console.error('Failed to load expert chat session:', error)
          logError(error)
          // Fallback: create new session
          try {
            const newSession = createExpertChatSession(expertModel)
            sessionId = newSession.sessionId
          } catch (createError) {
            console.error('Failed to create fallback expert chat session:', createError)
            logError(createError)
            throw new Error('Unable to create or load chat session')
          }
        }
      }

      // Check for cancellation before loading history
      if (isInterrupted || abortController.signal.aborted) {
        return yield* this.handleInterrupt()
      }

      // Load history and prepare messages with error handling
      let historyMessages: Array<{ role: string; content: string }>
      try {
        historyMessages = getSessionMessages(sessionId)
      } catch (error) {
        console.error('Failed to load session messages:', error)
        logError(error)
        historyMessages = [] // Fallback to empty history
      }

      const messages = [...historyMessages, { role: 'user', content: question }]

      let systemMessages
      try {
        systemMessages = messages.map(msg =>
          msg.role === 'user'
            ? createUserMessage(msg.content)
            : createAssistantMessage(msg.content),
        )
      } catch (error) {
        console.error('Failed to create system messages:', error)
        logError(error)
        throw new Error('Failed to prepare conversation messages')
      }

      // Check for cancellation before model call
      if (isInterrupted || abortController.signal.aborted) {
        return yield* this.handleInterrupt()
      }

      // Yield progress message to show we're connecting
      yield {
        type: 'progress',
        content: createAssistantMessage(
          `Connecting to ${expertModel}... (timeout: 5 minutes)`
        ),
      }

      // Call model with comprehensive error handling and timeout
      let response
      try {
        // Debug: Log the model we're trying to use (using global debug logger)
        const modelManager = getModelManager()
        const modelResolution = modelManager.resolveModelWithInfo(expertModel)

        debugLogger.api('EXPERT_MODEL_RESOLUTION', {
          requestedModel: expertModel,
          success: modelResolution.success,
          profileName: modelResolution.profile?.name,
          profileModelName: modelResolution.profile?.modelName,
          provider: modelResolution.profile?.provider,
          isActive: modelResolution.profile?.isActive,
          error: modelResolution.error,
        })

        // Create a timeout promise to prevent hanging
        const timeoutMs = 300000 // 300 seconds (5 minutes) timeout for external models
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => {
            reject(new Error(`Expert model query timed out after ${timeoutMs/1000}s`))
          }, timeoutMs)
        })

        // Race between the query and timeout
        response = await Promise.race([
          queryLLM(
            systemMessages,
            [], // no system prompt - let expert model use its default behavior
            0, // no thinking tokens needed
            [], // no tools needed
            abortController.signal,
            {
              safeMode: false,
              model: expertModel,
              prependCLISysprompt: false, // KEY: avoid injecting CLI context
            },
          ),
          timeoutPromise
        ])
      } catch (error: any) {
        console.error('Expert model query failed:', error)
        logError(error)

        // Check for specific error types
        if (
          error.name === 'AbortError' ||
          abortController.signal?.aborted ||
          isInterrupted
        ) {
          return yield* this.handleInterrupt()
        }

        if (error.message?.includes('timed out')) {
          throw new Error(
            `Expert model '${expertModel}' timed out after 5 minutes.\n\n` +
            `Suggestions:\n` +
            `  - The model might be experiencing high load\n` +
            `  - Try a different model or retry later\n` +
            `  - Consider breaking down your question into smaller parts`,
          )
        }

        if (error.message?.includes('rate limit')) {
          throw new Error(
            `Rate limit exceeded for ${expertModel}.\n\n` +
            `Please wait a moment and try again, or use a different model.`,
          )
        }

        if (error.message?.includes('invalid api key')) {
          throw new Error(
            `Invalid API key for ${expertModel}.\n\n` +
            `Please check your model configuration with /model command.`,
          )
        }

        if (
          error.message?.includes('model not found') ||
          error.message?.includes('Failed to resolve model')
        ) {
          // Provide helpful model guidance in runtime errors too
          try {
            const modelManager = getModelManager()
            const availableModels = modelManager.getAllAvailableModelNames()
            if (availableModels.length > 0) {
              throw new Error(
                `Model '${expertModel}' is not configured. Available models: ${availableModels.join(', ')}. Check if any available model closely matches the user's request (e.g., 'kimi' matches 'kimi-k2-0711-preview'). If there's a strong match, auto retry using the correct model name. If no close match exists, inform the user that '${expertModel}' needs to be configured using /model command.`,
              )
            } else {
              throw new Error(
                `Model '${expertModel}' not found and no models are currently configured in the system. Inform the user that models need to be configured first using the /model command.`,
              )
            }
          } catch (modelError) {
            // If we can't get model list, fall back to simple error
            throw new Error(
              `Model '${expertModel}' not found. Please check model configuration or inform user about the issue.`,
            )
          }
        }

        // Generic fallback
        throw new Error(
          `Expert model query failed: ${error.message || 'Unknown error'}`,
        )
      }

      // Extract answer with error handling
      let expertAnswer: string
      try {
        if (!response?.message?.content) {
          throw new Error('No content in expert response')
        }

        expertAnswer = response.message.content
          .filter(block => block.type === 'text')
          .map(block => (block as any).text)
          .join('\n')

        if (!expertAnswer.trim()) {
          throw new Error('Expert response was empty')
        }
      } catch (error) {
        console.error('Failed to extract expert answer:', error)
        logError(error)
        throw new Error('Failed to process expert response')
      }

      // Save conversation with error handling
      try {
        addMessageToSession(sessionId, 'user', question)
        addMessageToSession(sessionId, 'assistant', expertAnswer)
      } catch (error) {
        console.error('Failed to save conversation to session:', error)
        logError(error)
        // Don't throw here - we got a valid response, saving is non-critical
      }

      const result: Out = {
        chatSessionId: sessionId,
        expertModelName: expertModel,
        expertAnswer: expertAnswer,
      }

      yield {
        type: 'result',
        data: result,
        resultForAssistant: this.renderResultForAssistant(result),
      }
    } catch (error: any) {
      // Check if error is due to cancellation
      if (
        error.name === 'AbortError' ||
        abortController.signal?.aborted ||
        isInterrupted
      ) {
        return yield* this.handleInterrupt()
      }

      console.error('AskExpertModelTool execution failed:', error)
      logError(error)

      // Ensure we have a valid sessionId for error response
      const errorSessionId = sessionId || 'error-session'

      const errorMessage =
        error.message || 'Expert consultation failed with unknown error'
      const result: Out = {
        chatSessionId: errorSessionId,
        expertModelName: expertModel,
        expertAnswer: `❌ ${errorMessage}`,
      }

      yield {
        type: 'result',
        data: result,
        resultForAssistant: this.renderResultForAssistant(result),
      }
    } finally {
      // Clean up event listener
      abortController.signal.removeEventListener('abort', abortListener)
    }
  },

  // Unified interrupt handling method (following TaskTool pattern)
  async *handleInterrupt() {
    yield {
      type: 'result',
      data: {
        chatSessionId: 'interrupted',
        expertModelName: 'cancelled',
        expertAnswer: INTERRUPT_MESSAGE,
      },
      resultForAssistant: INTERRUPT_MESSAGE,
    }
  },
}
