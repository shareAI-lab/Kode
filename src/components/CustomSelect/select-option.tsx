import figures from 'figures'
import { Box, Text } from 'ink'
import React, { type ReactNode } from 'react'
import { type Theme } from './theme'
import { getTheme } from '../../utils/theme'

export type SelectOptionProps = {
  /**
   * Determines if option is focused.
   */
  readonly isFocused: boolean

  /**
   * Determines if option is selected.
   */
  readonly isSelected: boolean

  /**
   * Determines if pointer is shown when selected
   */
  readonly smallPointer?: boolean

  /**
   * Option label.
   */
  readonly children: ReactNode

  /**
   * React key prop (handled internally by React)
   */
  readonly key?: React.Key
}

export function SelectOption({
  isFocused,
  isSelected,
  smallPointer,
  children,
  ...props
}: SelectOptionProps) {
  const appTheme = getTheme()
  const styles = {
    option: ({ isFocused }: { isFocused: boolean }) => ({
      paddingLeft: 2,
      paddingRight: 1,
    }),
    focusIndicator: () => ({
      color: appTheme.kode,
    }),
    label: ({ isFocused, isSelected }: { isFocused: boolean; isSelected: boolean }) => ({
      color: isSelected 
        ? appTheme.success 
        : isFocused 
          ? appTheme.kode 
          : appTheme.text,
      bold: isSelected,
    }),
    selectedIndicator: () => ({
      color: appTheme.success,
    }),
  }

  return (
    <Box {...styles.option({ isFocused })}>
      {isFocused && (
        <Text {...styles.focusIndicator()}>
          {smallPointer ? figures.triangleDownSmall : figures.pointer}
        </Text>
      )}

      <Text {...styles.label({ isFocused, isSelected })}>{children}</Text>

      {isSelected && (
        <Text {...styles.selectedIndicator()}>{figures.tick}</Text>
      )}
    </Box>
  )
}
