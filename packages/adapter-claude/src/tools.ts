import type { ActionKind, JsonValue } from '@aang/contract'
import { isJsonObject, stringField } from './json.js'

const actionKinds: ReadonlyMap<string, ActionKind> = new Map([
  ['Bash', 'command'],
  ['BashOutput', 'command'],
  ['KillShell', 'command'],
  ['PowerShell', 'command'],
  ['Read', 'file_read'],
  ['NotebookRead', 'file_read'],
  ['Write', 'file_write'],
  ['Edit', 'file_write'],
  ['MultiEdit', 'file_write'],
  ['NotebookEdit', 'file_write'],
  ['Glob', 'search'],
  ['Grep', 'search'],
  ['LS', 'search'],
  ['WebFetch', 'web'],
  ['WebSearch', 'web'],
  ['Agent', 'agent'],
  ['Task', 'agent'],
  ['AskUserQuestion', 'question'],
  ['ExitPlanMode', 'plan'],
  ['EnterPlanMode', 'plan'],
  ['TodoWrite', 'plan'],
])

const mcpToolPrefix = 'mcp__'

export const actionKind = (tool: string): ActionKind =>
  actionKinds.get(tool) ?? (tool.startsWith(mcpToolPrefix) ? 'mcp' : 'other')

export const inputDescription = (input: JsonValue): string | null => stringField(input, 'description')

const textOfBlocks = (blocks: readonly JsonValue[]): string | null => {
  const texts = blocks.flatMap((block) =>
    isJsonObject(block) && block.type === 'text' && typeof block.text === 'string' ? [block.text] : [],
  )
  return texts.length === 0 ? null : texts.join('\n')
}

export const outputText = (output: JsonValue): string | null => {
  if (typeof output === 'string') {
    return output
  }
  if (Array.isArray(output)) {
    return textOfBlocks(output)
  }
  if (!isJsonObject(output)) {
    return null
  }
  const streams = [output.stdout, output.stderr].filter(
    (stream): stream is string => typeof stream === 'string' && stream.length > 0,
  )
  if (streams.length > 0) {
    return streams.join('\n')
  }
  const { content } = output
  return content === undefined ? null : outputText(content)
}

export const persistedOutputPath = (output: JsonValue): string | null => stringField(output, 'persistedOutputPath')

const exitCodePattern = /^Exit code (\d+)/

export const exitCode = (error: string): number | null => {
  const code = exitCodePattern.exec(error)?.[1]
  return code === undefined ? null : Number(code)
}
