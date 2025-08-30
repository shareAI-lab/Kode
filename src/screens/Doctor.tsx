import React, { useCallback, useEffect, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { Select } from '../components/CustomSelect/select'
import { getTheme } from '../utils/theme'
import { ConfigureNpmPrefix } from './ConfigureNpmPrefix'
import { platform } from 'process'
import {
  checkNpmPermissions,
  getDefaultNpmPrefix,
  getPermissionsCommand,
} from '../utils/autoUpdater.js'
import { saveGlobalConfig, getGlobalConfig } from '../utils/config'
import { logEvent } from '../services/statsig'
import { PRODUCT_NAME } from '../constants/product'
import { PressEnterToContinue } from '../components/PressEnterToContinue'

type Props = {
  onDone: () => void
  doctorMode?: boolean
}

type Option = {
  label: string
  value: 'auto' | 'manual' | 'ignore'
  description: string
}

export function Doctor({ onDone, doctorMode = false }: Props): React.ReactNode {
  const [hasPermissions, setHasPermissions] = useState<boolean | null>(null)
  const [npmPrefix, setNpmPrefix] = useState<string | null>(null)
  const [selectedOption, setSelectedOption] = useState<Option['value'] | null>(
    null,
  )
  const [customPrefix, setCustomPrefix] = useState<string>(
    getDefaultNpmPrefix(),
  )
  const theme = getTheme()
  const [showingPermissionsMessage, setShowingPermissionsMessage] =
    useState(false)

  const options: Option[] = [
    {
      label: `Manually fix permissions on current npm prefix (Recommended)`,
      value: 'manual',
      description:
        platform === 'win32'
          ? 'Uses icacls to grant write permissions'
          : 'Uses sudo to change ownership',
    },
    {
      label: 'Create new npm prefix directory',
      value: 'auto',
      description:
        'Creates a new directory for global npm packages in your home directory',
    },
    {
      label: 'Skip configuration until next session',
      value: 'ignore',
      description: 'Skip this warning (you will be reminded again later)',
    },
  ]

  const checkPermissions = useCallback(async () => {
    const result = await checkNpmPermissions()
    logEvent('tengu_auto_updater_permissions_check', {
      hasPermissions: result.hasPermissions.toString(),
      npmPrefix: result.npmPrefix ?? 'null',
    })
    setHasPermissions(result.hasPermissions)
    if (result.npmPrefix) {
      setNpmPrefix(result.npmPrefix)
    }
    if (result.hasPermissions) {
      const config = getGlobalConfig()
      saveGlobalConfig({
        ...config,
        autoUpdaterStatus: 'enabled',
      })
      if (!doctorMode) {
        onDone()
      }
    }
  }, [onDone, doctorMode])

  useEffect(() => {
    logEvent('tengu_auto_updater_config_start', {})
    checkPermissions()
  }, [checkPermissions])

  useInput(
    (_input, key) => {
      if (
        (showingPermissionsMessage ||
          (doctorMode && hasPermissions === true)) &&
        key.return
      ) {
        onDone()
      }
    },
    {
      isActive:
        showingPermissionsMessage || (doctorMode && hasPermissions === true),
    },
  )

  if (hasPermissions === null) {
    return (
      <Box paddingX={1} paddingTop={1}>
        <Text color={theme.secondaryText}>Checking npm permissions…</Text>
      </Box>
    )
  }

  if (hasPermissions === true) {
    if (doctorMode) {
      return (
        <Box flexDirection="column" gap={1} paddingX={1} paddingTop={1}>
          <Text color={theme.success}>✓ npm permissions: OK</Text>
          <Text>Your installation is healthy and ready for auto-updates.</Text>
          <PressEnterToContinue />
        </Box>
      )
    }
    return (
      <Box paddingX={1} paddingTop={1}>
        <Text color={theme.success}>✓ Auto-updates enabled</Text>
      </Box>
    )
  }
  return (
    <Box
      borderColor={theme.permission}
      borderStyle="round"
      flexDirection="column"
      gap={1}
      paddingX={1}
      paddingTop={1}
    >
      <Text bold color={theme.permission}>
        Enable automatic updates?
      </Text>
      <Text>
        {PRODUCT_NAME} can&apos;t update itself because it doesn&apos;t have
        permissions. Do you want to fix this to get automatic updates?
      </Text>
      <Box flexDirection="column">
        {!selectedOption && (
          <Box marginLeft={2}>
            <Text>Select an option below to fix the permissions issue:</Text>
            <Select
              options={options}
              onChange={(value: string) => {
                if (
                  value !== 'auto' &&
                  value !== 'manual' &&
                  value !== 'ignore'
                )
                  return
                setSelectedOption(value)

                // Log option selection
                logEvent('tengu_auto_updater_config_option_selected', {
                  option: value as 'auto' | 'manual' | 'ignore',
                  npmPrefix: npmPrefix ?? 'null',
                })

                if (value === 'manual') {
                  const config = getGlobalConfig()
                  saveGlobalConfig({
                    ...config,
                    autoUpdaterStatus: 'not_configured',
                  })
                  setShowingPermissionsMessage(true)
                } else if (value === 'ignore') {
                  const config = getGlobalConfig()
                  saveGlobalConfig({
                    ...config,
                    autoUpdaterStatus: 'not_configured',
                  })
                  onDone()
                }
              }}
            />
          </Box>
        )}

        {selectedOption === 'auto' && (
          <Box marginLeft={2}>
            <ConfigureNpmPrefix
              customPrefix={customPrefix}
              onCustomPrefixChange={setCustomPrefix}
              onSuccess={checkPermissions}
              onCancel={onDone}
            />
          </Box>
        )}

        {selectedOption === 'manual' && (
          <>
            <Box marginLeft={4} flexDirection="column">
              <Text>Run this command in your terminal:</Text>
              <Box flexDirection="row" gap={1}>
                <Text color={theme.warning}>
                  {getPermissionsCommand(npmPrefix ?? '')}
                </Text>
              </Box>
              <Box flexDirection="row" gap={1}>
                <Text color={theme.suggestion}>
                  After running the command, restart {PRODUCT_NAME}
                </Text>
              </Box>
            </Box>
            <PressEnterToContinue />
          </>
        )}
      </Box>
    </Box>
  )
}
