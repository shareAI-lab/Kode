import { Box, Text } from 'ink'
import React from 'react'
import { logError } from '../../utils/log'
import { ToolUseBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { Tool } from '../../Tool'
import { Cost } from '../Cost'
import { ToolUseLoader } from '../ToolUseLoader'
import { getTheme } from '../../utils/theme'
import { BLACK_CIRCLE } from '../../constants/figures'
import { ThinkTool } from '../../tools/ThinkTool/ThinkTool'
import { AssistantThinkingMessage } from './AssistantThinkingMessage'
import { TaskToolMessage } from './TaskToolMessage'

type Props = {
  param: ToolUseBlockParam
  costUSD: number
  durationMs: number
  addMargin: boolean
  tools: Tool[]
  debug: boolean
  verbose: boolean
  erroredToolUseIDs: Set<string>
  inProgressToolUseIDs: Set<string>
  unresolvedToolUseIDs: Set<string>
  shouldAnimate: boolean
  shouldShowDot: boolean
}

export function AssistantToolUseMessage({
  param,
  costUSD,
  durationMs,
  addMargin,
  tools,
  debug,
  verbose,
  erroredToolUseIDs,
  inProgressToolUseIDs,
  unresolvedToolUseIDs,
  shouldAnimate,
  shouldShowDot,
}: Props): React.ReactNode {
  const tool = tools.find(_ => _.name === param.name)
  if (!tool) {
    logError(`Tool ${param.name} not found`)
    return null
  }
  const isQueued =
    !inProgressToolUseIDs.has(param.id) && unresolvedToolUseIDs.has(param.id)
  // Keeping color undefined makes the OS use the default color regardless of appearance
  const color = isQueued ? getTheme().secondaryText : undefined

  // TODO: Avoid this special case
  if (tool === ThinkTool) {
    // params were already validated in query(), so this won't throe
    const { thought } = ThinkTool.inputSchema.parse(param.input)
    return (
      <AssistantThinkingMessage
        param={{ thinking: thought, signature: '', type: 'thinking' }}
        addMargin={addMargin}
      />
    )
  }

  const userFacingToolName = tool.userFacingName ? tool.userFacingName() : tool.name
  return (
    <Box
      flexDirection="row"
      justifyContent="space-between"
      marginTop={addMargin ? 1 : 0}
      width="100%"
    >
      <Box>
        <Box
          flexWrap="nowrap"
          minWidth={userFacingToolName.length + (shouldShowDot ? 2 : 0)}
        >
          {shouldShowDot &&
            (isQueued ? (
              <Box minWidth={2}>
                <Text color={color}>{BLACK_CIRCLE}</Text>
              </Box>
            ) : (
              <ToolUseLoader
                shouldAnimate={shouldAnimate}
                isUnresolved={unresolvedToolUseIDs.has(param.id)}
                isError={erroredToolUseIDs.has(param.id)}
              />
            ))}
          {tool.name === 'Task' && param.input ? (
            <TaskToolMessage
              agentType={String((param.input as any).subagent_type || 'general-purpose')}
              bold={Boolean(!isQueued)}
              children={String(userFacingToolName || '')}
            />
          ) : (
            <Text color={color} bold={!isQueued}>
              {userFacingToolName}
            </Text>
          )}
        </Box>
        <Box flexWrap="nowrap">
          {Object.keys(param.input as { [key: string]: unknown }).length > 0 &&
            (() => {
              const toolMessage = tool.renderToolUseMessage(
                param.input as never,
                {
                  verbose,
                },
              )

              // If the tool returns a React component, render it directly
              if (React.isValidElement(toolMessage)) {
                return (
                  <Box flexDirection="row">
                    <Text color={color}>(</Text>
                    {toolMessage}
                    <Text color={color}>)</Text>
                  </Box>
                )
              }

              // If it's a string, wrap it in Text
              return <Text color={color}>({toolMessage})</Text>
            })()}
          <Text color={color}>…</Text>
        </Box>
      </Box>
      <Cost costUSD={costUSD} durationMs={durationMs} debug={debug} />
    </Box>
  )
}
