import type { Dirent } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { readSpool, type PlayerRoots, type PlayerStep, type Target } from '@aang/testkit'
import { filesIn, isMissing } from './files.js'
import type { Artifact, ControlEvent } from './schema.js'

export type ControlTarget = (
  | (Target & { readonly contains?: string })
  | { readonly hook: { readonly event: string; readonly sessionId?: string; readonly toolUseId?: string } }
) & { readonly occurrence?: 'first' | 'last' }

export interface CapturedArtifact extends Artifact {
  readonly content: string
}

export interface CreatedEntries {
  readonly sessions: readonly string[]
  readonly paths: readonly string[]
}

export interface Capture {
  readonly artifacts: CapturedArtifact[]
  readonly steps: PlayerStep[]
  readonly controlEvents: ControlEvent[]
  readonly scan: (final?: boolean) => Promise<void>
  readonly checkpoint: (label: string, target: ControlTarget, expectedMapChange: string) => Promise<void>
  readonly output: (text: string) => void
  readonly otlp: (body: string, receivedAt: number) => void
  readonly created: () => Promise<CreatedEntries>
}

export interface RegularProfiles {
  readonly project: string
  readonly claude: boolean
  readonly codex: boolean
}

export interface CaptureOptions {
  readonly regular?: RegularProfiles
}

interface Location {
  readonly root: keyof PlayerRoots
  readonly directory: string
  readonly prefix: string
  readonly admit?: (entry: string) => boolean
  readonly owner?: (document: unknown) => boolean
}

export const claudeProjectName = (path: string): string => path.replaceAll(/[^a-zA-Z0-9]/g, '-')

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

const wholeDocument = (bytes: Buffer): unknown => {
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch {
    return undefined
  }
}

const fieldsOf = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : undefined

const entriesOf = async (directory: string): Promise<Dirent[]> => (await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
  if (isMissing(error)) return []
  throw error
})).sort((a, b) => a.name.localeCompare(b.name))

const sessionName = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const sessionOf = (entry: string): string | undefined => {
  const name = entry.replace(/\.jsonl$/, '')
  return sessionName.test(name) ? name : undefined
}

const exists = (path: string): Promise<boolean> => stat(path).then(() => true, (error: unknown) => {
  if (isMissing(error)) return false
  throw error
})

const readBytes = (file: string): Promise<Buffer> => readFile(file).catch((error: unknown) => {
  if (isMissing(error)) return Buffer.alloc(0)
  throw error
})

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
  const { regular } = options
  const projectName = regular === undefined ? '' : claudeProjectName(regular.project)
  const sessions = new Set<string>()
  const ownProject = (entry: string): boolean => entry === projectName || entry.startsWith(`${projectName}-`)
  const claudeRegistry = (document: unknown): boolean => fieldsOf(document)?.['cwd'] === regular?.project
  const codexRollout = (document: unknown): boolean => {
    const line = fieldsOf(document)
    return line?.['type'] === 'session_meta' && fieldsOf(line['payload'])?.['cwd'] === regular?.project
  }
  const claudeRegular = regular?.claude === true
  const codexRegular = regular?.codex === true
  const locations: readonly Location[] = [
    { root: 'claude', directory: join(roots.claude, 'projects'), prefix: 'projects', ...claudeRegular ? { admit: ownProject } : {} },
    { root: 'claude', directory: join(roots.claude, 'teams'), prefix: 'teams', ...claudeRegular ? { admit: () => false } : {} },
    { root: 'claude', directory: join(roots.claude, 'sessions'), prefix: 'sessions', ...claudeRegular ? { owner: claudeRegistry } : {} },
    { root: 'claude', directory: join(roots.claude, 'tasks'), prefix: 'tasks', ...claudeRegular ? { admit: (entry: string) => sessions.has(entry) } : {} },
    { root: 'codex', directory: join(roots.codex, 'sessions'), prefix: 'sessions', ...codexRegular ? { owner: codexRollout } : {} },
    { root: 'codex', directory: join(roots.codex, 'archived_sessions'), prefix: 'archived_sessions', ...codexRegular ? { owner: codexRollout } : {} },
    { root: 'home', directory: join(roots.home, 'project'), prefix: 'project' },
  ]
  const listed = async (location: Location): Promise<string[]> => {
    const { admit } = location
    if (admit === undefined) return filesIn(location.directory)
    const files: string[] = []
    for (const entry of (await entriesOf(location.directory)).filter(({ name }) => admit(name))) {
      const path = join(location.directory, entry.name)
      files.push(...entry.isFile() ? [path] : await filesIn(path))
    }
    return files
  }
  const ignored = new Set<string>()
  for (const location of locations.filter(({ owner }) => owner !== undefined)) {
    for (const file of await filesIn(location.directory)) ignored.add(file)
  }
  const owned = new Map<string, Location['root']>()
  const foreign = async (file: string, location: Location, final: boolean): Promise<boolean> => {
    const { owner } = location
    if (owner === undefined || owned.has(file)) return false
    if (ignored.has(file)) return true
    const bytes = await readBytes(file)
    const document = file.endsWith('.jsonl') ? firstLine(bytes) : wholeDocument(bytes)
    if (document === undefined && !final) return true
    if (document !== undefined && document !== null && owner(document)) {
      owned.set(file, location.root)
      return false
    }
    ignored.add(file)
    return true
  }
  const scan = async (final = false): Promise<void> => {
    const present = new Set<string>()
    for (const location of locations) {
      for (const file of await listed(location)) {
        if (!/\.jsonl?$/.test(file)) continue
        if (await foreign(file, location, final)) continue
        present.add(file)
        if (location.root === 'claude' && location.prefix === 'projects') {
          const session = sessionOf(relative(location.directory, file).split(/[\\/]/)[1] ?? '')
          if (session !== undefined) sessions.add(session)
        }
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
  const created = async (): Promise<CreatedEntries> => {
    const ids = new Set<string>()
    const paths = new Set<string>()
    if (claudeRegular) {
      const projects = join(roots.claude, 'projects')
      for (const { name } of (await entriesOf(projects)).filter(({ name }) => ownProject(name))) {
        paths.add(join(projects, name))
        for (const entry of await entriesOf(join(projects, name))) {
          const session = sessionOf(entry.name)
          if (session !== undefined) ids.add(session)
        }
      }
      for (const session of sessions) ids.add(session)
      for (const directory of await entriesOf(roots.claude)) {
        if (!directory.isDirectory() || directory.name === 'projects') continue
        for (const { name } of await entriesOf(join(roots.claude, directory.name))) {
          if ([...ids].some((id) => name.includes(id))) paths.add(join(roots.claude, directory.name, name))
        }
      }
    }
    for (const [file, root] of owned) {
      if (!await exists(file)) continue
      paths.add(file)
      const thread = root === 'codex' ? fieldsOf(fieldsOf(firstLine(await readBytes(file)))?.['payload'])?.['id'] : undefined
      if (typeof thread === 'string') ids.add(thread)
    }
    return { sessions: [...ids].sort(), paths: [...paths].sort() }
  }
  return {
    artifacts, steps, controlEvents, scan, created,
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
          (target.hook.toolUseId === undefined || ('tool_use_id' in payload && payload.tool_use_id === target.hook.toolUseId))
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
