import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { z } from 'zod'
import { claudeProjectName } from '../capture.js'

const Block = z.looseObject({
  type: z.string(),
  id: z.string().optional(),
  name: z.string().optional(),
  input: z.unknown().optional(),
  text: z.string().optional(),
  tool_use_id: z.string().optional(),
  is_error: z.boolean().optional(),
  content: z.unknown().optional(),
})

const Attachment = z.looseObject({ type: z.string() })
export type Attachment = z.infer<typeof Attachment>

const Entry = z.looseObject({
  type: z.string(),
  subtype: z.string().optional(),
  attachment: Attachment.optional(),
  isCompactSummary: z.boolean().optional(),
  sessionId: z.string().optional(),
  compactMetadata: z.looseObject({ trigger: z.string().optional() }).optional(),
  message: z.looseObject({
    id: z.string().optional(),
    role: z.string().optional(),
    content: z.union([z.string(), z.array(Block)]).optional(),
    usage: z.looseObject({ input_tokens: z.number(), output_tokens: z.number() }).optional(),
  }).optional(),
})
type Entry = z.infer<typeof Entry>

export interface Transcript {
  readonly file: string
  readonly target: { readonly root: 'claude'; readonly path: string }
  readonly entries: readonly Entry[]
}

export interface ToolUse {
  readonly id: string
  readonly name: string
  readonly input: unknown
  readonly messageId: string | undefined
}

const projects = (claude: string): string => join(claude, 'projects')

export const readTranscript = async (claude: string, file: string): Promise<Transcript> => {
  const lines = (await readFile(file, 'utf8')).split('\n').filter((line) => line.trim() !== '')
  return {
    file,
    target: { root: 'claude', path: relative(claude, file).replaceAll('\\', '/') },
    entries: lines.map((line) => Entry.parse(JSON.parse(line))),
  }
}

export interface ClaudeProfile {
  readonly claude: string
  readonly project: string
}

export const transcriptFiles = async ({ claude, project }: ClaudeProfile): Promise<string[]> => {
  const name = claudeProjectName(project)
  const directories = (await readdir(projects(claude)).catch(() => [])).filter((directory) => directory === name || directory.startsWith(`${name}-`))
  const files: string[] = []
  for (const directory of directories) {
    const names = await readdir(join(projects(claude), directory)).catch(() => [])
    files.push(...names.filter((name) => name.endsWith('.jsonl')).map((name) => join(projects(claude), directory, name)))
  }
  return files
}

export const findTranscript = async (profile: ClaudeProfile, sessionId: string): Promise<Transcript> => {
  const file = (await transcriptFiles(profile)).find((path) => path.endsWith(`${sessionId}.jsonl`))
  if (file === undefined) throw new Error(`No transcript for session ${sessionId}`)
  return readTranscript(profile.claude, file)
}

export const subagentTranscripts = async (claude: string, transcript: Transcript): Promise<Transcript[]> => {
  const directory = join(transcript.file.slice(0, -'.jsonl'.length), 'subagents')
  const names = (await readdir(directory).catch(() => [])).filter((name) => /^agent-.+\.jsonl$/.test(name))
  return Promise.all(names.map((name) => readTranscript(claude, join(directory, name))))
}

export const attachments = (transcript: Transcript): Attachment[] =>
  transcript.entries.flatMap((entry) => entry.type === 'attachment' && entry.attachment !== undefined ? [entry.attachment] : [])

const AgentMeta = z.looseObject({ agentType: z.string(), toolUseId: z.string().optional() })

export const subagentMetas = async (transcript: Transcript): Promise<(z.infer<typeof AgentMeta> & { readonly transcript: string })[]> => {
  const directory = join(transcript.file.slice(0, -'.jsonl'.length), 'subagents')
  const names = (await readdir(directory).catch(() => [])).filter((name) => /^agent-.+\.meta\.json$/.test(name))
  return Promise.all(names.map(async (name) => ({
    ...AgentMeta.parse(JSON.parse(await readFile(join(directory, name), 'utf8'))),
    transcript: join(directory, `${name.slice(0, -'.meta.json'.length)}.jsonl`),
  })))
}

const blocks = (entry: Entry): z.infer<typeof Block>[] => {
  const content = entry.message?.content
  return Array.isArray(content) ? content : []
}

export const toolUses = (transcript: Transcript): ToolUse[] => transcript.entries.flatMap((entry) => entry.type !== 'assistant' ? [] : blocks(entry).flatMap((block) =>
  block.type === 'tool_use' && block.id !== undefined && block.name !== undefined
    ? [{ id: block.id, name: block.name, input: block.input, messageId: entry.message?.id }]
    : []))

export const toolResult = (transcript: Transcript, toolUseId: string): { readonly isError: boolean; readonly text: string } | undefined => {
  for (const entry of transcript.entries) {
    for (const block of blocks(entry)) {
      if (block.type === 'tool_result' && block.tool_use_id === toolUseId) {
        return { isError: block.is_error === true, text: typeof block.content === 'string' ? block.content : JSON.stringify(block.content) }
      }
    }
  }
  return undefined
}

export const userTexts = (transcript: Transcript): string[] => transcript.entries.flatMap((entry) => {
  if (entry.type !== 'user') return []
  const content = entry.message?.content
  if (typeof content === 'string') return [content]
  return blocks(entry).flatMap((block) => block.type === 'text' && block.text !== undefined ? [block.text] : [])
})

export const named = (uses: readonly ToolUse[], name: string): ToolUse[] => uses.filter((use) => use.name === name)

export const commandOf = (use: ToolUse): string => {
  const parsed = z.looseObject({ command: z.string() }).safeParse(use.input)
  return parsed.success ? parsed.data.command : ''
}
