import { readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { readSpool, type PlayerRoots, type PlayerStep, type Target } from '@aang/testkit'
import { filesIn, isMissing } from './files.js'
import type { Artifact, ControlEvent } from './schema.js'

export type ControlTarget = (
  | (Target & { readonly contains?: string })
  | { readonly hook: { readonly event: string; readonly sessionId?: string; readonly toolUseId?: string; readonly notificationType?: string } }
) & { readonly occurrence?: 'first' | 'last' }

export interface CapturedArtifact extends Artifact {
  readonly content: string
}

export interface Capture {
  readonly artifacts: CapturedArtifact[]
  readonly steps: PlayerStep[]
  readonly controlEvents: ControlEvent[]
  readonly scan: (final?: boolean) => Promise<void>
  readonly checkpoint: (label: string, target: ControlTarget, expectedMapChange: string) => Promise<void>
  readonly output: (text: string) => void
  readonly otlp: (body: string, receivedAt: number) => void
}

export interface CaptureOptions {
  readonly codexOwner?: (first: unknown) => boolean
}

const jsonLines = (bytes: Buffer, final: boolean): Buffer => {
  const end = bytes.lastIndexOf(0x0a) + 1
  if (final && end !== bytes.length) throw new Error('Incomplete JSONL at end of recording')
  const complete = bytes.subarray(0, end)
  for (const line of complete.toString('utf8').split('\n').filter((line) => line.trim())) JSON.parse(line)
  return complete
}

const firstLine = (bytes: Buffer): unknown => {
  const end = bytes.indexOf(0x0a)
  if (end < 0) return undefined
  try {
    return JSON.parse(bytes.subarray(0, end).toString('utf8'))
  } catch {
    return null
  }
}

export const createCapture = async (roots: PlayerRoots, spool: string, started: number, options: CaptureOptions = {}): Promise<Capture> => {
  const artifacts: CapturedArtifact[] = []
  const steps: PlayerStep[] = []
  const controlEvents: ControlEvent[] = []
  const contents = new Map<string, Buffer>()
  const targets = new Map<string, Target>()
  const hooks = new Set<string>()
  const at = (): number => Math.max(0, Date.now() - started)
  const add = (content: string, directory: string, extension: string, mtime: bigint, observed: number): string => {
    const source = `${directory}/${String(artifacts.length + 1).padStart(6, '0')}.${extension}`
    artifacts.push({ source, content, observed_at: new Date(started + observed).toISOString(), mtime_ns: String(mtime) })
    return source
  }
  const locations: readonly { root: keyof PlayerRoots; directory: string; prefix: string }[] = [
    { root: 'claude', directory: join(roots.claude, 'projects'), prefix: 'projects' },
    { root: 'claude', directory: join(roots.claude, 'teams'), prefix: 'teams' },
    { root: 'claude', directory: join(roots.claude, 'sessions'), prefix: 'sessions' },
    { root: 'claude', directory: join(roots.claude, 'tasks'), prefix: 'tasks' },
    { root: 'codex', directory: join(roots.codex, 'sessions'), prefix: 'sessions' },
    { root: 'codex', directory: join(roots.codex, 'archived_sessions'), prefix: 'archived_sessions' },
    { root: 'home', directory: join(roots.home, 'project'), prefix: 'project' },
  ]
  const { codexOwner } = options
  const ignored = new Set<string>()
  if (codexOwner !== undefined) {
    for (const location of locations.filter(({ root }) => root === 'codex')) {
      for (const file of await filesIn(location.directory)) ignored.add(file)
    }
  }
  const owned = new Set<string>()
  const foreign = async (file: string, root: keyof PlayerRoots, final: boolean): Promise<boolean> => {
    if (codexOwner === undefined || root !== 'codex' || owned.has(file)) return false
    if (ignored.has(file)) return true
    const bytes = await readFile(file).catch((error: unknown) => {
      if (isMissing(error)) return Buffer.alloc(0)
      throw error
    })
    const first = firstLine(bytes)
    if (first === undefined && !final) return true
    if (first !== undefined && first !== null && codexOwner(first)) {
      owned.add(file)
      return false
    }
    ignored.add(file)
    return true
  }
  const scan = async (final = false): Promise<void> => {
    const present = new Set<string>()
    for (const location of locations) {
      for (const file of await filesIn(location.directory)) {
        if (!/\.jsonl?$/.test(file)) continue
        if (await foreign(file, location.root, final)) continue
        present.add(file)
        const result = await Promise.all([readFile(file), stat(file, { bigint: true })]).catch((error: unknown) => {
          if (isMissing(error)) return undefined
          throw error
        })
        if (result === undefined) continue
        const [raw, info] = result
        let bytes: Buffer
        try {
          new TextDecoder('utf-8', { fatal: true }).decode(file.endsWith('.jsonl') ? raw.subarray(0, raw.lastIndexOf(0x0a) + 1) : raw)
          bytes = file.endsWith('.jsonl') ? jsonLines(raw, final) : raw
          if (file.endsWith('.json')) JSON.parse(bytes.toString('utf8'))
        } catch (error) {
          if (final) throw error
          continue
        }
        const previous = contents.get(file)
        if (previous?.equals(bytes) || (bytes.length === 0 && previous === undefined)) continue
        const target = { root: location.root, path: `${location.prefix}/${relative(location.directory, file).replaceAll('\\', '/')}` }
        const observed = at()
        const append = file.endsWith('.jsonl') && (previous === undefined || bytes.subarray(0, previous.length).equals(previous))
        const content = append ? bytes.subarray(previous?.length ?? 0) : bytes
        const source = add(content.toString('utf8'), 'data', file.endsWith('.jsonl') ? 'jsonl' : 'json', info.mtimeNs, observed)
        steps.push({ kind: append ? 'append' : 'write', at: observed, target, source })
        contents.set(file, bytes)
        targets.set(file, target)
      }
    }
    for (const [file, target] of targets) {
      if (!present.has(file)) {
        steps.push({ kind: 'remove', at: at(), target })
        contents.delete(file)
        targets.delete(file)
      }
    }
    for (const event of await readSpool(spool)) {
      if (hooks.has(event.name)) continue
      const observed = Math.max(0, Number(event.receivedAt / 1_000_000n) - started)
      const bytes = await readFile(join(spool, 'new', event.name))
      add(new TextDecoder('utf-8', { fatal: true }).decode(bytes), 'spool', 'spool', event.receivedAt, observed)
      const source = add(new TextDecoder('utf-8', { fatal: true }).decode(event.payload), 'data', 'json', event.receivedAt, observed)
      steps.push({ kind: 'hook', at: observed, source, ...event.header })
      hooks.add(event.name)
    }
    steps.sort((left, right) => left.at - right.at)
    for (let index = 0; index < controlEvents.length; index += 1) {
      const event = controlEvents[index]
      if (event) controlEvents[index] = { ...event, step: steps.findIndex((step) => step.label === event.label) }
    }
  }
  return {
    artifacts, steps, controlEvents, scan,
    checkpoint: async (label, target, expectedMapChange) => {
      await scan(true)
      const content = (step: PlayerStep): string | undefined => 'source' in step ? artifacts.find((artifact) => artifact.source === step.source)?.content : undefined
      const matches = (step: PlayerStep): boolean => {
        if (!('hook' in target)) {
          return 'target' in step && step.target.root === target.root && step.target.path === target.path &&
            (target.contains === undefined || (content(step)?.includes(target.contains) ?? false))
        }
        if (step.kind !== 'hook') return false
        const payload: unknown = JSON.parse(content(step) ?? 'null')
        return payload !== null && typeof payload === 'object' &&
          'hook_event_name' in payload && payload.hook_event_name === target.hook.event &&
          (target.hook.sessionId === undefined || ('session_id' in payload && payload.session_id === target.hook.sessionId)) &&
          (target.hook.toolUseId === undefined || ('tool_use_id' in payload && payload.tool_use_id === target.hook.toolUseId)) &&
          (target.hook.notificationType === undefined || ('notification_type' in payload && payload.notification_type === target.hook.notificationType))
      }
      const index = target.occurrence === 'first' ? steps.findIndex(matches) : steps.findLastIndex(matches)
      const step = steps[index]
      if (!label.trim() || !expectedMapChange.trim() || controlEvents.some((event) => event.label === label) || !step || step.label) {
        throw new Error('Checkpoint must name a new captured event and a unique label with an expected map change')
      }
      steps[index] = { ...step, label }
      controlEvents.push({ label, step: index, observed_at: new Date(started + step.at).toISOString(), expected_map_change: { description: expectedMapChange } })
    },
    output: (text) => {
      if (text) add(text, 'output', 'txt', BigInt(Date.now()) * 1_000_000n, at())
    },
    otlp: (body, receivedAt) => {
      JSON.parse(body)
      const observed = Math.max(0, receivedAt - started)
      const source = add(body, 'data', 'json', BigInt(receivedAt) * 1_000_000n, observed)
      steps.push({ kind: 'otlp', at: observed, source })
    },
  }
}
