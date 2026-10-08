import { readdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

export interface JsonLines {
  readonly path: string
  readonly lines: readonly Readonly<Record<string, unknown>>[]
}

const filesUnder = async (directory: string): Promise<string[]> => {
  try {
    const entries = await readdir(directory, { recursive: true, withFileTypes: true })
    return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name))
  } catch {
    return []
  }
}

const readLines = async (path: string): Promise<JsonLines> => ({
  path,
  lines: (await readFile(path, 'utf8'))
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>),
})

export const claudeTranscripts = async (claude: string, session: string): Promise<string[]> =>
  (await filesUnder(join(claude, 'projects'))).filter((path) => basename(path) === `${session}.jsonl`)

export const claudeTranscript = async (claude: string, session: string): Promise<JsonLines> => {
  const [path, ...others] = await claudeTranscripts(claude, session)
  if (path === undefined || others.length > 0) {
    throw new Error(`expected one transcript of ${session}, found ${String(others.length + (path === undefined ? 0 : 1))}`)
  }
  return readLines(path)
}

const contentBlocks = (line: Readonly<Record<string, unknown>>): readonly Readonly<Record<string, unknown>>[] => {
  const message = line['message']
  if (typeof message !== 'object' || message === null) return []
  const content = (message as Record<string, unknown>)['content']
  return Array.isArray(content) ? (content as Record<string, unknown>[]) : []
}

export const claudeToolUses = (transcript: JsonLines): string[] =>
  [
    ...new Set(
      transcript.lines
        .filter((line) => line['type'] === 'assistant')
        .flatMap(contentBlocks)
        .filter((block) => block['type'] === 'tool_use')
        .map((block) => String(block['id'])),
    ),
  ]

export const claudeUsageMessages = (transcript: JsonLines): string[] =>
  [
    ...new Set(
      transcript.lines.flatMap((line) => {
        const message = line['message'] as Record<string, unknown> | undefined
        return line['type'] === 'assistant' && message?.['usage'] !== undefined ? [String(message['id'])] : []
      }),
    ),
  ]

export const codexRollouts = async (codex: string, thread: string): Promise<string[]> =>
  [...(await filesUnder(join(codex, 'sessions'))), ...(await filesUnder(join(codex, 'archived_sessions')))].filter(
    (path) => basename(path).endsWith(`${thread}.jsonl`),
  )

export const codexRollout = async (codex: string, thread: string): Promise<JsonLines> => {
  const [path, ...others] = await codexRollouts(codex, thread)
  if (path === undefined || others.length > 0) {
    throw new Error(`expected one rollout of ${thread}, found ${String(others.length + (path === undefined ? 0 : 1))}`)
  }
  return readLines(path)
}

export const codexCalls = (rollout: JsonLines): string[] =>
  [
    ...new Set(
      rollout.lines.flatMap((line) => {
        const payload = line['payload'] as Record<string, unknown> | undefined
        return line['type'] === 'response_item' &&
          (payload?.['type'] === 'function_call' || payload?.['type'] === 'custom_tool_call')
          ? [String(payload['call_id'])]
          : []
      }),
    ),
  ]

export const codexThreadOf = (stdout: string): string => {
  for (const line of stdout.split('\n')) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>
      if (event['type'] === 'thread.started' && typeof event['thread_id'] === 'string') return event['thread_id']
    } catch {
      continue
    }
  }
  throw new Error(`no thread.started event in codex output: ${stdout.slice(0, 400)}`)
}

export const claudeSessionOf = (stdout: string): string => {
  for (const line of stdout.split('\n')) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>
      if (event['type'] === 'system' && event['subtype'] === 'init' && typeof event['session_id'] === 'string') {
        return event['session_id']
      }
    } catch {
      continue
    }
  }
  throw new Error(`no init event in claude output: ${stdout.slice(0, 400)}`)
}
