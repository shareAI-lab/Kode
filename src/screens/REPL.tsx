import { ToolUseBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { Box, Newline, Static, Text } from 'ink'
import ProjectOnboarding, {
  markProjectOnboardingComplete,
} from '../ProjectOnboarding.js'
import { CostThresholdDialog } from '../components/CostThresholdDialog'
import * as React from 'react'
import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { Command } from '../commands'
import { Logo } from '../components/Logo'
import { Message } from '../components/Message'
import { MessageResponse } from '../components/MessageResponse'
import { MessageSelector } from '../components/MessageSelector'
import {
  PermissionRequest,
  type ToolUseConfirm,
} from '../components/permissions/PermissionRequest.js'
import PromptInput from '../components/PromptInput'
import { Spinner } from '../components/Spinner'
import { getSystemPrompt } from '../constants/prompts'
import { getContext } from '../context'
import { getTotalCost, useCostSummary } from '../cost-tracker'
import { useLogStartupTime } from '../hooks/useLogStartupTime'
import { addToHistory } from '../history'
import { useApiKeyVerification } from '../hooks/useApiKeyVerification'
import { useCancelRequest } from '../hooks/useCancelRequest'
import useCanUseTool from '../hooks/useCanUseTool'
import { useLogMessages } from '../hooks/useLogMessages'
import { PermissionProvider } from '../context/PermissionContext'
import { ModeIndicator } from '../components/ModeIndicator'
import {
  setMessagesGetter,
  setMessagesSetter,
  setModelConfigChangeHandler,
} from '../messages'
import {
  type AssistantMessage,
  type BinaryFeedbackResult,
  type Message as MessageType,
  type ProgressMessage,
  query,
} from '../query.js'
import type { WrappedClient } from '../services/mcpClient'
import type { Tool } from '../Tool'
import { AutoUpdaterResult } from '../utils/autoUpdater'
import { getGlobalConfig, saveGlobalConfig } from '../utils/config'
import { MACRO } from '../constants/macros'
import { logEvent } from '../services/statsig'
import { getNextAvailableLogForkNumber } from '../utils/log'
import {
  getErroredToolUseMessages,
  getInProgressToolUseIDs,
  getLastAssistantMessageId,
  getToolUseID,
  getUnresolvedToolUseIDs,
  INTERRUPT_MESSAGE,
  isNotEmptyMessage,
  type NormalizedMessage,
  normalizeMessages,
  normalizeMessagesForAPI,
  processUserInput,
  reorderMessages,
  extractTag,
  createAssistantMessage,
} from '../utils/messages.js'
import { getModelManager, ModelManager } from '../utils/model'
import { clearTerminal, updateTerminalTitle } from '../utils/terminal'
import { BinaryFeedback } from '../components/binary-feedback/BinaryFeedback'
import { getMaxThinkingTokens } from '../utils/thinking'
import { getOriginalCwd } from '../utils/state'
import { handleHashCommand } from '../commands/terminalSetup'
import { debug as debugLogger } from '../utils/debugLogger'

type Props = {
  commands: Command[]
  safeMode?: boolean
  debug?: boolean
  initialForkNumber?: number | undefined
  initialPrompt: string | undefined
  // A unique name for the message log file, used to identify the fork
  messageLogName: string
  shouldShowPromptInput: boolean
  tools: Tool[]
  verbose: boolean | undefined
  // Initial messages to populate the REPL with
  initialMessages?: MessageType[]
  // MCP clients
  mcpClients?: WrappedClient[]
  // Flag to indicate if current model is default
  isDefaultModel?: boolean
  // Update banner info passed from CLI before first render
  initialUpdateVersion?: string | null
  initialUpdateCommands?: string[] | null
}

export type BinaryFeedbackContext = {
  m1: AssistantMessage
  m2: AssistantMessage
  resolve: (result: BinaryFeedbackResult) => void
}

export function REPL({
  commands,
  safeMode,
  debug = false,
  initialForkNumber = 0,
  initialPrompt,
  messageLogName,
  shouldShowPromptInput,
  tools,
  verbose: verboseFromCLI,
  initialMessages,
  mcpClients = [],
  isDefaultModel = true,
  initialUpdateVersion,
  initialUpdateCommands,
}: Props): React.ReactNode {
  // TODO: probably shouldn't re-read config from file synchronously on every keystroke
  const verbose = verboseFromCLI ?? getGlobalConfig().verbose

  // Used to force the logo to re-render and conversation log to use a new file
  const [forkNumber, setForkNumber] = useState(
    getNextAvailableLogForkNumber(messageLogName, initialForkNumber, 0),
  )

  const [
    forkConvoWithMessagesOnTheNextRender,
    setForkConvoWithMessagesOnTheNextRender,
  ] = useState<MessageType[] | null>(null)

  // 🔧 Simplified AbortController management - inspired by reference system
  const [abortController, setAbortController] = useState<AbortController | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [autoUpdaterResult, setAutoUpdaterResult] =
    useState<AutoUpdaterResult | null>(null)
  const [toolJSX, setToolJSX] = useState<{
    jsx: React.ReactNode | null
    shouldHidePromptInput: boolean
  } | null>(null)
  const [toolUseConfirm, setToolUseConfirm] = useState<ToolUseConfirm | null>(
    null,
  )
  const [messages, setMessages] = useState<MessageType[]>(initialMessages ?? [])
  const [inputValue, setInputValue] = useState('')
  const [inputMode, setInputMode] = useState<'bash' | 'prompt' | 'koding'>(
    'prompt',
  )
  const [submitCount, setSubmitCount] = useState(0)
  const [isMessageSelectorVisible, setIsMessageSelectorVisible] =
    useState(false)
  const [showCostDialog, setShowCostDialog] = useState(false)
  const [haveShownCostDialog, setHaveShownCostDialog] = useState(
    getGlobalConfig().hasAcknowledgedCostThreshold,
  )

  const [binaryFeedbackContext, setBinaryFeedbackContext] =
    useState<BinaryFeedbackContext | null>(null)
  // New version banner: passed in from CLI to guarantee top placement
  const updateAvailableVersion = initialUpdateVersion ?? null
  const updateCommands = initialUpdateCommands ?? null
  // No separate Static for banner; it renders inside Logo

  const getBinaryFeedbackResponse = useCallback(
    (
      m1: AssistantMessage,
      m2: AssistantMessage,
    ): Promise<BinaryFeedbackResult> => {
      return new Promise<BinaryFeedbackResult>(resolvePromise => {
        setBinaryFeedbackContext({
          m1,
          m2,
          resolve: resolvePromise,
        })
      })
    },
    [],
  )

  const readFileTimestamps = useRef<{
    [filename: string]: number
  }>({})

  const { status: apiKeyStatus, reverify } = useApiKeyVerification()
  function onCancel() {
    if (!isLoading) {
      return
    }
    setIsLoading(false)
    if (toolUseConfirm) {
      toolUseConfirm.onAbort()
    } else if (abortController && !abortController.signal.aborted) {
      abortController.abort()
    }
  }

  useCancelRequest(
    setToolJSX,
    setToolUseConfirm,
    setBinaryFeedbackContext,
    onCancel,
    isLoading,
    isMessageSelectorVisible,
    abortController?.signal,
  )

  useEffect(() => {
    if (forkConvoWithMessagesOnTheNextRender) {
      setForkNumber(_ => _ + 1)
      setForkConvoWithMessagesOnTheNextRender(null)
      setMessages(forkConvoWithMessagesOnTheNextRender)
    }
  }, [forkConvoWithMessagesOnTheNextRender])

  useEffect(() => {
    const totalCost = getTotalCost()
    if (totalCost >= 5 /* $5 */ && !showCostDialog && !haveShownCostDialog) {
      logEvent('tengu_cost_threshold_reached', {})
      setShowCostDialog(true)
    }
  }, [messages, showCostDialog, haveShownCostDialog])

  // Update banner is provided by CLI at startup; no async check here.

  const canUseTool = useCanUseTool(setToolUseConfirm)

  async function onInit() {
    reverify()

    if (!initialPrompt) {
      return
    }

    setIsLoading(true)

    const newAbortController = new AbortController()
    setAbortController(newAbortController)

    // 🔧 Force fresh config read to ensure model switching works
    const model = new ModelManager(getGlobalConfig()).getModelName('main')
    const newMessages = await processUserInput(
      initialPrompt,
      'prompt',
      setToolJSX,
      {
        abortController: newAbortController,
        options: {
          commands,
          forkNumber,
          messageLogName,
          tools,
          verbose,
          maxThinkingTokens: 0,
        },
        messageId: getLastAssistantMessageId(messages),
        setForkConvoWithMessagesOnTheNextRender,
        readFileTimestamps: readFileTimestamps.current,
      },
      null,
    )

    if (newMessages.length) {
      for (const message of newMessages) {
        if (message.type === 'user') {
          addToHistory(initialPrompt)
          // TODO: setHistoryIndex
        }
      }
      setMessages(_ => [..._, ...newMessages])

      // The last message is an assistant message if the user input was a bash command,
      // or if the user input was an invalid slash command.
      const lastMessage = newMessages[newMessages.length - 1]!
      if (lastMessage.type === 'assistant') {
        setAbortController(null)
        setIsLoading(false)
        return
      }

      const [systemPrompt, context, model, maxThinkingTokens] =
        await Promise.all([
          getSystemPrompt(),
          getContext(),
          new ModelManager(getGlobalConfig()).getModelName('main'),
          getMaxThinkingTokens([...messages, ...newMessages]),
        ])

      for await (const message of query(
        [...messages, ...newMessages],
        systemPrompt,
        context,
        canUseTool,
        {
          options: {
            commands,
            forkNumber,
            messageLogName,
            tools,
            verbose,
            safeMode,
            maxThinkingTokens,
          },
          messageId: getLastAssistantMessageId([...messages, ...newMessages]),
          readFileTimestamps: readFileTimestamps.current,
          abortController: newAbortController,
          setToolJSX,
        },
        getBinaryFeedbackResponse,
      )) {
        setMessages(oldMessages => [...oldMessages, message])
      }
    } else {
      addToHistory(initialPrompt)
      // TODO: setHistoryIndex
    }

    setHaveShownCostDialog(
      getGlobalConfig().hasAcknowledgedCostThreshold || false,
    )

    // 🔧 Fix: Clean up state after onInit completion
    setIsLoading(false)
    setAbortController(null)
  }

  async function onQuery(newMessages: MessageType[], passedAbortController?: AbortController) {
    // Use passed AbortController or create new one
    const controllerToUse = passedAbortController || new AbortController()
    if (!passedAbortController) {
      setAbortController(controllerToUse)
    }

    // Check if this is a Koding request based on last message's options
    const isKodingRequest =
      newMessages.length > 0 &&
      newMessages[0].type === 'user' &&
      'options' in newMessages[0] &&
      newMessages[0].options?.isKodingRequest === true

    setMessages(oldMessages => [...oldMessages, ...newMessages])

    // Mark onboarding as complete when any user message is sent to Claude
    markProjectOnboardingComplete()

    // The last message is an assistant message if the user input was a bash command,
    // or if the user input was an invalid slash command.
    const lastMessage = newMessages[newMessages.length - 1]!

    // Update terminal title based on user message
    if (
      lastMessage.type === 'user' &&
      typeof lastMessage.message.content === 'string'
    ) {
      // updateTerminalTitle(lastMessage.message.content)
    }
    if (lastMessage.type === 'assistant') {
      setAbortController(null)
      setIsLoading(false)
      return
    }

    const [systemPrompt, context, model, maxThinkingTokens] =
      await Promise.all([
        getSystemPrompt(),
        getContext(),
        new ModelManager(getGlobalConfig()).getModelName('main'),
        getMaxThinkingTokens([...messages, lastMessage]),
      ])

    let lastAssistantMessage: MessageType | null = null

    // query the API
    for await (const message of query(
      [...messages, lastMessage],
      systemPrompt,
      context,
      canUseTool,
      {
        options: {
          commands,
          forkNumber,
          messageLogName,
          tools,
          verbose,
          safeMode,
          maxThinkingTokens,
          // If this came from Koding mode, pass that along
          isKodingRequest: isKodingRequest || undefined,
        },
        messageId: getLastAssistantMessageId([...messages, lastMessage]),
        readFileTimestamps: readFileTimestamps.current,
        abortController: controllerToUse,
        setToolJSX,
      },
      getBinaryFeedbackResponse,
    )) {
      setMessages(oldMessages => [...oldMessages, message])

      // Keep track of the last assistant message for Koding mode
      if (message.type === 'assistant') {
        lastAssistantMessage = message
      }
    }

    // If this was a Koding request and we got an assistant message back,
    // save it to AGENTS.md (and CLAUDE.md if exists)
    if (
      isKodingRequest &&
      lastAssistantMessage &&
      lastAssistantMessage.type === 'assistant'
    ) {
      try {
        const content =
          typeof lastAssistantMessage.message.content === 'string'
            ? lastAssistantMessage.message.content
            : lastAssistantMessage.message.content
                .filter(block => block.type === 'text')
                .map(block => (block.type === 'text' ? block.text : ''))
                .join('\n')

        // Add the content to AGENTS.md (and CLAUDE.md if exists)
        if (content && content.trim().length > 0) {
          handleHashCommand(content)
        }
      } catch (error) {
        console.error('Error saving response to project docs:', error)
      }
    }

    setIsLoading(false)
  }

  // Register cost summary tracker
  useCostSummary()

  // Register messages getter and setter
  useEffect(() => {
    const getMessages = () => messages
    setMessagesGetter(getMessages)
    setMessagesSetter(setMessages)
  }, [messages])

  // Register model config change handler for UI refresh
  useEffect(() => {
    setModelConfigChangeHandler(() => {
      setForkNumber(prev => prev + 1)
    })
  }, [])

  // Record transcripts locally, for debugging and conversation recovery
  useLogMessages(messages, messageLogName, forkNumber)

  // Log startup time
  useLogStartupTime()

  // Initial load
  useEffect(() => {
    onInit()
    // TODO: fix this
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const normalizedMessages = useMemo(
    () => normalizeMessages(messages).filter(isNotEmptyMessage),
    [messages],
  )

  const unresolvedToolUseIDs = useMemo(
    () => getUnresolvedToolUseIDs(normalizedMessages),
    [normalizedMessages],
  )

  const inProgressToolUseIDs = useMemo(
    () => getInProgressToolUseIDs(normalizedMessages),
    [normalizedMessages],
  )

  const erroredToolUseIDs = useMemo(
    () =>
      new Set(
        getErroredToolUseMessages(normalizedMessages).map(
          _ => (_.message.content[0]! as ToolUseBlockParam).id,
        ),
      ),
    [normalizedMessages],
  )

  const messagesJSX = useMemo(() => {
    return [
      {
        type: 'static',
        jsx: (
          <Box flexDirection="column" key={`logo${forkNumber}`}>
            <Logo
              mcpClients={mcpClients}
              isDefaultModel={isDefaultModel}
              updateBannerVersion={updateAvailableVersion}
              updateBannerCommands={updateCommands}
            />
            <ProjectOnboarding workspaceDir={getOriginalCwd()} />
          </Box>
        ),
      },
      ...reorderMessages(normalizedMessages).map(_ => {
        const toolUseID = getToolUseID(_)
        const message =
          _.type === 'progress' ? (
            _.content.message.content[0]?.type === 'text' &&
            // Hack: TaskTool interrupts use Progress messages, so don't
            // need an extra ⎿ because <Message /> already adds one.
            // TODO: Find a cleaner way to do this.
            _.content.message.content[0].text === INTERRUPT_MESSAGE ? (
              <Message
                message={_.content}
                messages={_.normalizedMessages}
                addMargin={false}
                tools={_.tools}
                verbose={verbose ?? false}
                debug={debug}
                erroredToolUseIDs={new Set()}
                inProgressToolUseIDs={new Set()}
                unresolvedToolUseIDs={new Set()}
                shouldAnimate={false}
                shouldShowDot={false}
              />
            ) : (
              <MessageResponse>
                <Message
                  message={_.content}
                  messages={_.normalizedMessages}
                  addMargin={false}
                  tools={_.tools}
                  verbose={verbose ?? false}
                  debug={debug}
                  erroredToolUseIDs={new Set()}
                  inProgressToolUseIDs={new Set()}
                  unresolvedToolUseIDs={
                    new Set([
                      (_.content.message.content[0]! as ToolUseBlockParam).id,
                    ])
                  }
                  shouldAnimate={false}
                  shouldShowDot={false}
                />
              </MessageResponse>
            )
          ) : (
            <Message
              message={_}
              messages={normalizedMessages}
              addMargin={true}
              tools={tools}
              verbose={verbose}
              debug={debug}
              erroredToolUseIDs={erroredToolUseIDs}
              inProgressToolUseIDs={inProgressToolUseIDs}
              shouldAnimate={
                !toolJSX &&
                !toolUseConfirm &&
                !isMessageSelectorVisible &&
                (!toolUseID || inProgressToolUseIDs.has(toolUseID))
              }
              shouldShowDot={true}
              unresolvedToolUseIDs={unresolvedToolUseIDs}
            />
          )

        const type = shouldRenderStatically(
          _,
          normalizedMessages,
          unresolvedToolUseIDs,
        )
          ? 'static'
          : 'transient'

        if (debug) {
          return {
            type,
            jsx: (
              <Box
                borderStyle="single"
                borderColor={type === 'static' ? 'green' : 'red'}
                key={_.uuid}
                width="100%"
              >
                {message}
              </Box>
            ),
          }
        }

        return {
          type,
          jsx: (
            <Box key={_.uuid} width="100%">
              {message}
            </Box>
          ),
        }
      }),
    ]
  }, [
    forkNumber,
    normalizedMessages,
    tools,
    verbose,
    debug,
    erroredToolUseIDs,
    inProgressToolUseIDs,
    toolJSX,
    toolUseConfirm,
    isMessageSelectorVisible,
    unresolvedToolUseIDs,
    mcpClients,
    isDefaultModel,
  ])

  // only show the dialog once not loading
  const showingCostDialog = !isLoading && showCostDialog

  return (
    <PermissionProvider isBypassPermissionsModeAvailable={!safeMode}>
      {/* Update banner now renders inside Logo for stable placement */}
      <ModeIndicator />
      <React.Fragment key={`static-messages-${forkNumber}`}>
        <Static
          items={messagesJSX.filter(_ => _.type === 'static')}
        >
          {_ => _.jsx}
        </Static>
      </React.Fragment>
      {messagesJSX.filter(_ => _.type === 'transient').map(_ => _.jsx)}
      <Box
        borderColor="red"
        borderStyle={debug ? 'single' : undefined}
        flexDirection="column"
        width="100%"
      >
        {!toolJSX && !toolUseConfirm && !binaryFeedbackContext && isLoading && (
          <Spinner />
        )}
        {toolJSX ? toolJSX.jsx : null}
        {!toolJSX && binaryFeedbackContext && !isMessageSelectorVisible && (
          <BinaryFeedback
            m1={binaryFeedbackContext.m1}
            m2={binaryFeedbackContext.m2}
            resolve={result => {
              binaryFeedbackContext.resolve(result)
              setTimeout(() => setBinaryFeedbackContext(null), 0)
            }}
            verbose={verbose}
            normalizedMessages={normalizedMessages}
            tools={tools}
            debug={debug}
            erroredToolUseIDs={erroredToolUseIDs}
            inProgressToolUseIDs={inProgressToolUseIDs}
            unresolvedToolUseIDs={unresolvedToolUseIDs}
          />
        )}
        {!toolJSX &&
          toolUseConfirm &&
          !isMessageSelectorVisible &&
          !binaryFeedbackContext && (
            <PermissionRequest
              toolUseConfirm={toolUseConfirm}
              onDone={() => setToolUseConfirm(null)}
              verbose={verbose}
            />
          )}
        {!toolJSX &&
          !toolUseConfirm &&
          !isMessageSelectorVisible &&
          !binaryFeedbackContext &&
          showingCostDialog && (
            <CostThresholdDialog
              onDone={() => {
                setShowCostDialog(false)
                setHaveShownCostDialog(true)
                const projectConfig = getGlobalConfig()
                saveGlobalConfig({
                  ...projectConfig,
                  hasAcknowledgedCostThreshold: true,
                })
                logEvent('tengu_cost_threshold_acknowledged', {})
              }}
            />
          )}

        {!toolUseConfirm &&
          !toolJSX?.shouldHidePromptInput &&
          shouldShowPromptInput &&
          !isMessageSelectorVisible &&
          !binaryFeedbackContext &&
          !showingCostDialog && (
            <>
              <PromptInput
                commands={commands}
                forkNumber={forkNumber}
                messageLogName={messageLogName}
                tools={tools}
                isDisabled={apiKeyStatus === 'invalid'}
                isLoading={isLoading}
                onQuery={onQuery}
                debug={debug}
                verbose={verbose}
                messages={messages}
                setToolJSX={setToolJSX}
                onAutoUpdaterResult={setAutoUpdaterResult}
                autoUpdaterResult={autoUpdaterResult}
                input={inputValue}
                onInputChange={setInputValue}
                mode={inputMode}
                onModeChange={setInputMode}
                submitCount={submitCount}
                onSubmitCountChange={setSubmitCount}
                setIsLoading={setIsLoading}
                setAbortController={setAbortController}
                onShowMessageSelector={() =>
                  setIsMessageSelectorVisible(prev => !prev)
                }
                setForkConvoWithMessagesOnTheNextRender={
                  setForkConvoWithMessagesOnTheNextRender
                }
                readFileTimestamps={readFileTimestamps.current}
                abortController={abortController}
                onModelChange={() => setForkNumber(prev => prev + 1)}
              />
            </>
          )}
      </Box>
      {isMessageSelectorVisible && (
        <MessageSelector
          erroredToolUseIDs={erroredToolUseIDs}
          unresolvedToolUseIDs={unresolvedToolUseIDs}
          messages={normalizeMessagesForAPI(messages)}
          onSelect={async message => {
            setIsMessageSelectorVisible(false)

            // If the user selected the current prompt, do nothing
            if (!messages.includes(message)) {
              return
            }

            // Cancel tool use calls/requests
            onCancel()

            // Hack: make sure the "Interrupted by user" message is
            // rendered in response to the cancellation. Otherwise,
            // the screen will be cleared but there will remain a
            // vestigial "Interrupted by user" message at the top.
            setImmediate(async () => {
              // Clear messages, and re-render
              await clearTerminal()
              setMessages([])
              setForkConvoWithMessagesOnTheNextRender(
                messages.slice(0, messages.indexOf(message)),
              )

              // Populate/reset the prompt input
              if (typeof message.message.content === 'string') {
                setInputValue(message.message.content)
              }
            })
          }}
          onEscape={() => setIsMessageSelectorVisible(false)}
          tools={tools}
        />
      )}
      {/** Fix occasional rendering artifact */}
      <Newline />
    </PermissionProvider>
  )
}

function shouldRenderStatically(
  message: NormalizedMessage,
  messages: NormalizedMessage[],
  unresolvedToolUseIDs: Set<string>,
): boolean {
  switch (message.type) {
    case 'user':
    case 'assistant': {
      const toolUseID = getToolUseID(message)
      if (!toolUseID) {
        return true
      }
      if (unresolvedToolUseIDs.has(toolUseID)) {
        return false
      }

      const correspondingProgressMessage = messages.find(
        _ => _.type === 'progress' && _.toolUseID === toolUseID,
      ) as ProgressMessage | null
      if (!correspondingProgressMessage) {
        return true
      }

      return !intersects(
        unresolvedToolUseIDs,
        correspondingProgressMessage.siblingToolUseIDs,
      )
    }
    case 'progress':
      return !intersects(unresolvedToolUseIDs, message.siblingToolUseIDs)
  }
}

function intersects<A>(a: Set<A>, b: Set<A>): boolean {
  return a.size > 0 && b.size > 0 && [...a].some(_ => b.has(_))
}
