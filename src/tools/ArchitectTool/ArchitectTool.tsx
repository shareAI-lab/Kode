import type { TextBlock } from '@anthropic-ai/sdk/resources/index.mjs'
import { Box } from 'ink'
import * as React from 'react'
import { z } from 'zod'
import type { Tool } from '../../Tool'
import { FallbackToolUseRejectedMessage } from '../../components/FallbackToolUseRejectedMessage'
import { HighlightedCode } from '../../components/HighlightedCode'
import { getContext } from '../../context'
import { Message, query } from '../../query'
import { lastX } from '../../utils/generators'
import { createUserMessage } from '../../utils/messages'
import { BashTool } from '../BashTool/BashTool'
import { FileReadTool } from '../FileReadTool/FileReadTool'
import { FileWriteTool } from '../FileWriteTool/FileWriteTool'
import { GlobTool } from '../GlobTool/GlobTool'
import { GrepTool } from '../GrepTool/GrepTool'
import { LSTool } from '../lsTool/lsTool'
import { ARCHITECT_SYSTEM_PROMPT, DESCRIPTION } from './prompt'

const FS_EXPLORATION_TOOLS: Tool[] = [
  BashTool,
  LSTool,
  FileReadTool,
  FileWriteTool,
  GlobTool,
  GrepTool,
]

const inputSchema = z.strictObject({
  prompt: z
    .string()
    .describe('The technical request or coding task to analyze'),
  context: z
    .string()
    .describe('Optional context from previous conversation or system state')
    .optional(),
})

export const ArchitectTool = {
  name: 'Architect',
  async description() {
    return DESCRIPTION
  },
  inputSchema,
  isReadOnly() {
    return true
  },
  isConcurrencySafe() {
    return true // ArchitectTool is read-only, safe for concurrent execution
  },
  userFacingName() {
    return 'Architect'
  },
  async isEnabled() {
    return false
  },
  needsPermissions() {
    return false
  },
  async *call({ prompt, context }, toolUseContext) {
    const content = context
      ? `<context>${context}</context>\n\n${prompt}`
      : prompt

    const userMessage = createUserMessage(content)

    const messages: Message[] = [userMessage]

    // We only allow the file exploration tools to be used in the architect tool
    const allowedTools = (toolUseContext.options?.tools ?? []).filter(_ =>
      FS_EXPLORATION_TOOLS.map(_ => _.name).includes(_.name),
    )

    // Create a dummy canUseTool function since this tool controls its own tool usage
    const canUseTool = async () => ({ result: true as const })

    const lastResponse = await lastX(
      query(
        messages,
        [ARCHITECT_SYSTEM_PROMPT],
        await getContext(),
        canUseTool,
        {
          ...toolUseContext,
          setToolJSX: () => {}, // Dummy function since ArchitectTool doesn't use UI
          options: { 
            commands: toolUseContext.options?.commands || [],
            forkNumber: toolUseContext.options?.forkNumber || 0,
            messageLogName: toolUseContext.options?.messageLogName || 'default',
            verbose: toolUseContext.options?.verbose || false,
            safeMode: toolUseContext.options?.safeMode || false,
            maxThinkingTokens: toolUseContext.options?.maxThinkingTokens || 0,
            ...toolUseContext.options, 
            tools: allowedTools 
          },
        },
      ),
    )

    if (lastResponse.type !== 'assistant') {
      throw new Error(`Invalid response from API`)
    }

    const data = lastResponse.message.content.filter(_ => _.type === 'text')
    yield {
      type: 'result',
      data,
      resultForAssistant: this.renderResultForAssistant(data),
    }
  },
  async prompt() {
    return DESCRIPTION
  },
  renderResultForAssistant(data: TextBlock[]): string {
    return data.map(block => block.text).join('\n')
  },
  renderToolUseMessage(input) {
    return Object.entries(input)
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join(', ')
  },
  renderToolResultMessage(content) {
    return (
      <Box flexDirection="column" gap={1}>
        <HighlightedCode
          code={content.map(_ => _.text).join('\n')}
          language="markdown"
        />
      </Box>
    )
  },
  renderToolUseRejectedMessage() {
    return <FallbackToolUseRejectedMessage />
  },
} satisfies Tool<typeof inputSchema, TextBlock[]>
