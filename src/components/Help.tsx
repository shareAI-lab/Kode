import { Command } from '../commands'
import { PRODUCT_COMMAND, PRODUCT_NAME } from '../constants/product'
import {
  getCustomCommandDirectories,
  hasCustomCommands,
  type CustomCommandWithScope,
} from '../services/customCommands'
import * as React from 'react'
import { Box, Text, useInput } from 'ink'
import { getTheme } from '../utils/theme'
import { PressEnterToContinue } from './PressEnterToContinue'
import { MACRO } from '../constants/macros'

/**
 * Help Component - Interactive help system with progressive disclosure
 *
 * This component provides a comprehensive help interface that progressively
 * reveals information to avoid overwhelming users. It categorizes commands
 * into built-in and custom types, providing clear guidance on usage.
 *
 * The progressive disclosure pattern (count-based) ensures users can absorb
 * information at their own pace while maintaining a responsive interface.
 */
export function Help({
  commands,
  onClose,
}: {
  commands: Command[]
  onClose: () => void
}): React.ReactNode {
  const theme = getTheme()
  const moreHelp = `Learn more at: ${MACRO.README_URL}`

  // Filter out hidden commands from the help display
  const filteredCommands = commands.filter(cmd => !cmd.isHidden)

  // Separate built-in commands from custom commands
  // Built-in commands are those that don't follow the custom command patterns
  const builtInCommands = filteredCommands.filter(
    cmd => !cmd.name.startsWith('project:') && !cmd.name.startsWith('user:'),
  )

  // Custom commands are those with project: or user: prefixes
  const customCommands = filteredCommands.filter(
    cmd => cmd.name.startsWith('project:') || cmd.name.startsWith('user:'),
  ) as CustomCommandWithScope[]

  // Progressive disclosure state for managing information flow
  const [count, setCount] = React.useState(0)

  // Timer-based progressive disclosure to prevent information overload
  React.useEffect(() => {
    const timer = setTimeout(() => {
      if (count < 3) {
        setCount(count + 1)
      }
    }, 250)

    return () => clearTimeout(timer)
  }, [count])

  // Handle Enter key to close help
  useInput((_, key) => {
    if (key.return) onClose()
  })

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color={theme.kode}>
        {`${PRODUCT_NAME} v${MACRO.VERSION}`}
      </Text>

      <Box marginTop={1} flexDirection="column">
        <Text>
          {PRODUCT_NAME} is a beta research preview. Always review{' '}
          {PRODUCT_NAME}&apos;s responses, especially when running code.{' '}
          {PRODUCT_NAME} has read access to files in the current directory and
          can run commands and edit files with your permission.
        </Text>
      </Box>

      {count >= 1 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Usage Modes:</Text>
          <Text>
            • REPL: <Text bold>{PRODUCT_COMMAND}</Text> (interactive session)
          </Text>
          <Text>
            • Non-interactive:{' '}
            <Text bold>{PRODUCT_COMMAND} -p &quot;question&quot;</Text>
          </Text>
          <Box marginTop={1}>
            <Text>
              Run <Text bold>{PRODUCT_COMMAND} -h</Text> for all command line
              options
            </Text>
          </Box>
        </Box>
      )}

      {count >= 2 && (
        <Box marginTop={1} flexDirection="column">
          <Text bold>Common Tasks:</Text>
          <Text>
            • Ask questions about your codebase{' '}
            <Text color={getTheme().secondaryText}>
              &gt; How does foo.py work?
            </Text>
          </Text>
          <Text>
            • Edit files{' '}
            <Text color={getTheme().secondaryText}>
              &gt; Update bar.ts to...
            </Text>
          </Text>
          <Text>
            • Fix errors{' '}
            <Text color={getTheme().secondaryText}>&gt; cargo build</Text>
          </Text>
          <Text>
            • Run commands{' '}
            <Text color={getTheme().secondaryText}>&gt; /help</Text>
          </Text>
          <Text>
            • Run bash commands{' '}
            <Text color={getTheme().secondaryText}>&gt; !ls</Text>
          </Text>
        </Box>
      )}

      {count >= 3 && (
        <Box marginTop={1} flexDirection="column">
          <Text bold>Built-in Commands:</Text>

          <Box flexDirection="column">
            {builtInCommands.map((cmd, i) => (
              <Box key={i} marginLeft={1}>
                <Text bold>{`/${cmd.name}`}</Text>
                <Text> - {cmd.description}</Text>
              </Box>
            ))}
          </Box>

          {customCommands.length > 0 && (
            <>
              <Box marginTop={1}>
                <Text bold>Custom Commands:</Text>
              </Box>

              <Box flexDirection="column">
                {customCommands.map((cmd, i) => (
                  <Box key={i} marginLeft={1}>
                    <Text bold color={theme.kode}>{`/${cmd.name}`}</Text>
                    <Text> - {cmd.description}</Text>
                    {cmd.aliases && cmd.aliases.length > 0 && (
                      <Text color={theme.secondaryText}>
                        {' '}
                        (aliases: {cmd.aliases.join(', ')})
                      </Text>
                    )}
                    {/* Show scope indicator for debugging */}
                    {cmd.scope && (
                      <Text color={theme.secondaryText}> [{cmd.scope}]</Text>
                    )}
                  </Box>
                ))}
              </Box>
            </>
          )}

          {/* Show custom command directory information */}
          {hasCustomCommands() || customCommands.length > 0 ? (
            <Box marginTop={1}>
              <Text color={theme.secondaryText}>
                Custom commands loaded from:
              </Text>
              <Text color={theme.secondaryText}>
                • {getCustomCommandDirectories().userClaude} (user: prefix)
              </Text>
              <Text color={theme.secondaryText}>
                • {getCustomCommandDirectories().projectClaude} (project: prefix)
              </Text>
              <Text color={theme.secondaryText}>
                Use /refresh-commands to reload after changes
              </Text>
            </Box>
          ) : (
            <Box marginTop={1}>
              <Text color={theme.secondaryText}>
                Create custom commands by adding .md files to:
              </Text>
              <Text color={theme.secondaryText}>
                • {getCustomCommandDirectories().userClaude} (user: prefix)
              </Text>
              <Text color={theme.secondaryText}>
                • {getCustomCommandDirectories().projectClaude} (project: prefix)
              </Text>
              <Text color={theme.secondaryText}>
                Use /refresh-commands to reload after creation
              </Text>
            </Box>
          )}
        </Box>
      )}

      <Box marginTop={1}>
        <Text color={theme.secondaryText}>{moreHelp}</Text>
      </Box>

      <Box marginTop={2}>
        <PressEnterToContinue />
      </Box>
    </Box>
  )
}
