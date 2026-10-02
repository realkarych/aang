import { readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { readSpool, type Target } from '@aang/testkit'
import { z } from 'zod'
import type { ControlTarget } from '../capture.js'
import { filesIn } from '../files.js'

export type Json = Readonly<Record<string, unknown>>

const Line = z.looseObject({ type: z.string(), payload: z.looseObject({ type: z.string().optional() }).optional() })
export type RolloutLine = z.infer<typeof Line>

export interface Rollout {
  readonly path: string
  readonly target: Target
  readonly lines: readonly RolloutLine[]
}

export const check = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(`Scenario check failed: ${message}`)
}

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)

export const jsonLines = (text: string): Json[] =>
  text.split(/\r?\n/).filter((line) => line.trim().startsWith('{')).flatMap((line) => {
    try {
      const value: unknown = JSON.parse(line)
      return isObject(value) ? [value] : []
    } catch {
      return []
    }
  })

export const threadOf = (stdout: string): string => {
  const started = jsonLines(stdout).find((event) => event['type'] === 'thread.started')
  const id = started?.['thread_id']
  check(typeof id === 'string', 'codex exec --json printed thread.started with a thread id')
  return id as string
}

export const items = (stdout: string, type: string): Json[] =>
  jsonLines(stdout).flatMap((event) => {
    const item = event['item']
    return event['type'] === 'item.completed' && isObject(item) && item['type'] === type ? [item] : []
  })

export const rolloutFiles = async (codexHome: string): Promise<string[]> => {
  const directories = [join(codexHome, 'sessions'), join(codexHome, 'archived_sessions')]
  const files = await Promise.all(directories.map((directory) => filesIn(directory)))
  return files.flat().filter((file) => file.endsWith('.jsonl'))
}

export const readRollout = async (codexHome: string, path: string): Promise<Rollout> => {
  const lines = jsonLines(await readFile(path, 'utf8')).flatMap((line) => {
    const parsed = Line.safeParse(line)
    return parsed.success ? [parsed.data] : []
  })
  return { path, target: { root: 'codex', path: relative(codexHome, path).replaceAll('\\', '/') }, lines }
}

export type Occurrence = 'first' | 'last'

export const containing = (rollout: Rollout, text: string, occurrence: Occurrence = 'last'): ControlTarget => ({ ...rollout.target, contains: text, occurrence })

export const finished = (rollout: Rollout, occurrence: Occurrence = 'last'): ControlTarget => containing(rollout, '"type":"task_complete"', occurrence)

export const allRollouts = async (codexHome: string): Promise<Rollout[]> =>
  Promise.all((await rolloutFiles(codexHome)).map((file) => readRollout(codexHome, file)))

export const rolloutOf = async (codexHome: string, thread: string): Promise<Rollout> => {
  const path = (await rolloutFiles(codexHome)).find((file) => file.endsWith(`-${thread}.jsonl`))
  check(path !== undefined, `a rollout of thread ${thread} exists`)
  return readRollout(codexHome, path as string)
}

export const events = (rollout: Rollout, type: string): Json[] =>
  rollout.lines.flatMap((line) => line.type === 'event_msg' && line.payload?.type === type ? [line.payload] : [])

export const responseItems = (rollout: Rollout, type: string): Json[] =>
  rollout.lines.flatMap((line) => line.type === 'response_item' && line.payload?.type === type ? [line.payload] : [])

export const records = (rollout: Rollout, type: string): Json[] =>
  rollout.lines.flatMap((line) => line.type === type && line.payload !== undefined ? [line.payload] : [])

export const completedItems = (rollout: Rollout, type: string): Json[] =>
  events(rollout, 'item_completed').flatMap((event) => {
    const item = event['item']
    return isObject(item) && item['type'] === type ? [item] : []
  })

export const sessionMeta = (rollout: Rollout): Json => {
  const meta = records(rollout, 'session_meta')[0]
  check(meta !== undefined, `${rollout.target.path} starts with session_meta`)
  return meta as Json
}

export interface HookRecord extends Json {
  readonly hook_event_name: string
}

const isHookRecord = (value: unknown): value is HookRecord => isObject(value) && typeof value['hook_event_name'] === 'string'

export const hookRecords = async (spool: string): Promise<HookRecord[]> =>
  (await readSpool(spool)).flatMap((event) => {
    try {
      const payload: unknown = JSON.parse(event.payload.toString('utf8'))
      return isHookRecord(payload) ? [payload] : []
    } catch {
      return []
    }
  })

export const hooksNamed = (hooks: readonly HookRecord[], event: string, field?: { readonly key: string; readonly value: unknown }): HookRecord[] =>
  hooks.filter((hook) => hook.hook_event_name === event && (field === undefined || hook[field.key] === field.value))
