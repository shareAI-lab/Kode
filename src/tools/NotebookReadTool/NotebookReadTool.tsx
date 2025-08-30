import type {
  ImageBlockParam,
  TextBlockParam,
} from '@anthropic-ai/sdk/resources/index.mjs'

import { existsSync, readFileSync } from 'fs'
import { Text } from 'ink'
import { extname, isAbsolute, relative, resolve } from 'path'
import * as React from 'react'
import { z } from 'zod'
import { FallbackToolUseRejectedMessage } from '../../components/FallbackToolUseRejectedMessage'
import { Tool } from '../../Tool'
import {
  NotebookCellSource,
  NotebookContent,
  NotebookCell,
  NotebookOutputImage,
  NotebookCellSourceOutput,
  NotebookCellOutput,
  NotebookCellType,
} from '../../types/notebook'
import { formatOutput } from '../BashTool/utils'
import { getCwd } from '../../utils/state'
import { findSimilarFile } from '../../utils/file'
import { DESCRIPTION, PROMPT } from './prompt'
import { hasReadPermission } from '../../utils/permissions/filesystem'

const inputSchema = z.strictObject({
  notebook_path: z
    .string()
    .describe(
      'The absolute path to the Jupyter notebook file to read (must be absolute, not relative)',
    ),
})

type In = typeof inputSchema
type Out = NotebookCellSource[]


export const NotebookReadTool = {
  name: 'ReadNotebook',
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return PROMPT
  },
  isReadOnly() {
    return true
  },
  isConcurrencySafe() {
    return true // NotebookReadTool is read-only, safe for concurrent execution
  },
  inputSchema,
  userFacingName() {
    return 'Read Notebook'
  },
  async isEnabled() {
    return true
  },
  needsPermissions({ notebook_path }) {
    return !hasReadPermission(notebook_path)
  },
  async validateInput({ notebook_path }) {
    const fullFilePath = isAbsolute(notebook_path)
      ? notebook_path
      : resolve(getCwd(), notebook_path)

    if (!existsSync(fullFilePath)) {
      // Try to find a similar file with a different extension
      const similarFilename = findSimilarFile(fullFilePath)
      let message = 'File does not exist.'

      // If we found a similar file, suggest it to the assistant
      if (similarFilename) {
        message += ` Did you mean ${similarFilename}?`
      }

      return {
        result: false,
        message,
      }
    }

    if (extname(fullFilePath) !== '.ipynb') {
      return {
        result: false,
        message: 'File must be a Jupyter notebook (.ipynb file).',
      }
    }

    return { result: true }
  },
  renderToolUseMessage(input, { verbose }) {
    return `notebook_path: ${verbose ? input.notebook_path : relative(getCwd(), input.notebook_path)}`
  },
  renderToolUseRejectedMessage() {
    return <FallbackToolUseRejectedMessage />
  },

  renderToolResultMessage(content) {
    if (!content) {
      return <Text>No cells found in notebook</Text>
    }
    if (content.length < 1 || !content[0]) {
      return <Text>No cells found in notebook</Text>
    }
    return <Text>Read {content.length} cells</Text>
  },
  async *call({ notebook_path }) {
    const fullPath = isAbsolute(notebook_path)
      ? notebook_path
      : resolve(getCwd(), notebook_path)

    const content = readFileSync(fullPath, 'utf-8')
    const notebook = JSON.parse(content) as NotebookContent
    const language = notebook.metadata.language_info?.name ?? 'python'
    const cells = notebook.cells.map((cell, index) =>
      processCell(cell, index, language),
    )

    yield {
      type: 'result',
      resultForAssistant: this.renderResultForAssistant(cells),
      data: cells,
    }
  },
  renderResultForAssistant(data: NotebookCellSource[]) {
    // Convert the complex structure to a string representation for the assistant
    return data.map((cell, index) => {
      let content = `Cell ${index + 1} (${cell.cellType}):\n${cell.source}`
      if (cell.outputs && cell.outputs.length > 0) {
        const outputText = cell.outputs.map(output => output.text).filter(Boolean).join('\n')
        if (outputText) {
          content += `\nOutput:\n${outputText}`
        }
      }
      return content
    }).join('\n\n')
  },
} satisfies Tool<In, Out>

function processOutputText(text: string | string[] | undefined): string {
  if (!text) return ''
  const rawText = Array.isArray(text) ? text.join('') : text
  const { truncatedContent } = formatOutput(rawText)
  return truncatedContent
}

function extractImage(
  data: Record<string, unknown>,
): NotebookOutputImage | undefined {
  if (typeof data['image/png'] === 'string') {
    return {
      image_data: data['image/png'] as string,
      media_type: 'image/png',
    }
  }
  if (typeof data['image/jpeg'] === 'string') {
    return {
      image_data: data['image/jpeg'] as string,
      media_type: 'image/jpeg',
    }
  }
  return undefined
}

function processOutput(output: NotebookCellOutput) {
  switch (output.output_type) {
    case 'stream':
      return {
        output_type: output.output_type,
        text: processOutputText(output.text),
      }
    case 'execute_result':
    case 'display_data':
      return {
        output_type: output.output_type,
        text: processOutputText(output.data?.['text/plain'] as string | string[] | undefined),
        image: output.data && extractImage(output.data),
      }
    case 'error':
      return {
        output_type: output.output_type,
        text: processOutputText(
          `${output.ename}: ${output.evalue}\n${output.traceback.join('\n')}`,
        ),
      }
  }
}

function processCell(
  cell: NotebookCell,
  index: number,
  language: string,
): NotebookCellSource {
  const cellData: NotebookCellSource = {
    cell: index,
    cellType: cell.cell_type,
    source: Array.isArray(cell.source) ? cell.source.join('') : cell.source,
    language,
    execution_count: cell.execution_count,
  }

  if (cell.outputs?.length) {
    cellData.outputs = cell.outputs.map(processOutput)
  }

  return cellData
}

function cellContentToToolResult(cell: NotebookCellSource): TextBlockParam {
  const metadata = []
  if (cell.cellType !== 'code') {
    metadata.push(`<cell_type>${cell.cellType}</cell_type>`)
  }
  if (cell.language !== 'python' && cell.cellType === 'code') {
    metadata.push(`<language>${cell.language}</language>`)
  }
  const cellContent = `<cell ${cell.cell}>${metadata.join('')}${cell.source}</cell ${cell.cell}>`
  return {
    text: cellContent,
    type: 'text',
  }
}

function cellOutputToToolResult(output: NotebookCellSourceOutput) {
  const outputs: (TextBlockParam | ImageBlockParam)[] = []
  if (output.text) {
    outputs.push({
      text: `\n${output.text}`,
      type: 'text',
    })
  }
  if (output.image) {
    outputs.push({
      type: 'image',
      source: {
        data: output.image.image_data,
        media_type: output.image.media_type,
        type: 'base64',
      },
    })
  }
  return outputs
}

function getToolResultFromCell(cell: NotebookCellSource) {
  const contentResult = cellContentToToolResult(cell)
  const outputResults = cell.outputs?.flatMap(cellOutputToToolResult)
  return [contentResult, ...(outputResults ?? [])]
}

export function isNotebookCellType(
  value: string | null,
): value is NotebookCellType {
  return value === 'code' || value === 'markdown'
}
