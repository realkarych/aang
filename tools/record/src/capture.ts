import { createHash, type Hash } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { lstat, open, readdir, readFile, stat } from 'node:fs/promises'
import { extname, join, relative } from 'node:path'
import { readSpool, type PlayerRoots, type PlayerStep, type Target } from '@aang/testkit'
import { filesIn, isMissing } from './files.js'
import { type Artifact, type ControlEvent, Segment } from './schema.js'

export type ControlTarget = (
  | (Target & { readonly contains?: string })
  | { readonly hook: { readonly event: string; readonly sessionId?: string; readonly toolUseId?: string; readonly notificationType?: string } }
) & { readonly occurrence?: 'first' | 'last' }

export interface CapturedArtifact extends Artifact {
  readonly content: string
}

export interface CreatedEntries {
  readonly sessions: readonly string[]
  readonly paths: readonly string[]
  readonly unreadable: readonly string[]
}

export interface Capture {
  readonly artifacts: CapturedArtifact[]
  readonly steps: PlayerStep[]
  readonly controlEvents: ControlEvent[]
  readonly scan: (final?: boolean) => Promise<void>
  readonly checkpoint: (label: string, target: ControlTarget, expectedMapChange: string) => Promise<void>
  readonly keep: (target: Target) => Promise<void>
  readonly output: (text: string) => void
  readonly otlp: (body: string, receivedAt: number) => void
  readonly created: () => Promise<CreatedEntries>
}

export interface RegularProfiles {
  readonly project: string
  readonly plugin: string
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

const readRange = async (file: string, start: number, end: number): Promise<Buffer> => {
  const handle = await open(file, 'r')
  try {
    const buffer = Buffer.alloc(end - start)
    let filled = 0
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, start + filled)
      if (bytesRead === 0) break
      filled += bytesRead
    }
    return buffer.subarray(0, filled)
  } finally {
    await handle.close()
  }
}

const tailLength = 4096

interface Lines {
  readonly length: number
  readonly tail: Buffer
  readonly hash: Hash
}

interface Change {
  readonly append: boolean
  readonly content: Buffer
}

const decoded = (bytes: Buffer): Buffer => {
  new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  return bytes
}

const digestOf = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

export const createCapture = async (roots: PlayerRoots, spool: string, started: number, options: CaptureOptions = {}): Promise<Capture> => {
  const artifacts: CapturedArtifact[] = []
  const steps: PlayerStep[] = []
  const controlEvents: ControlEvent[] = []
  const contents = new Map<string, Buffer>()
  const lines = new Map<string, Lines>()
  const seen = new Map<string, string>()
  const bySource = new Map<string, CapturedArtifact>()
  const targets = new Map<string, Target>()
  const kept = new Map<string, Target>()
  const hooks = new Set<string>()
  const at = (): number => Math.max(0, Date.now() - started)
  const add = (content: string, directory: string, extension: string, mtime: bigint, observed: number): string => {
    const source = `${directory}/${String(artifacts.length + 1).padStart(6, '0')}.${extension}`
    const artifact = { source, content, observed_at: new Date(started + observed).toISOString(), mtime_ns: String(mtime) }
    artifacts.push(artifact)
    bySource.set(source, artifact)
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
  const pluginData = join(roots.claude, 'plugins', 'data')
  const ownPluginData = (name: string): boolean => name === regular?.plugin || name.startsWith(`${regular?.plugin ?? ''}-`)
  const existingPluginData = new Set(claudeRegular ? (await entriesOf(pluginData)).map(({ name }) => name) : [])
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
  const locate = (): void => {
    for (let index = 0; index < controlEvents.length; index += 1) {
      const event = controlEvents[index]
      if (event) controlEvents[index] = { ...event, step: steps.findIndex((step) => step.label === event.label) }
    }
  }
  const splitAfter = (index: number, step: PlayerStep, text: string, occurrence: ControlTarget['occurrence']): void => {
    if (step.kind !== 'append') return
    const position = artifacts.findIndex((artifact) => artifact.source === step.source)
    const artifact = artifacts[position]
    if (artifact === undefined) return
    const parts = artifact.content.split(/(?<=\n)/)
    const line = occurrence === 'first' ? parts.findIndex((entry) => entry.includes(text)) : parts.findLastIndex((entry) => entry.includes(text))
    if (line < 0 || line === parts.length - 1) return
    const head = { ...artifact, content: parts.slice(0, line + 1).join('') }
    artifacts[position] = head
    bySource.set(head.source, head)
    const source = add(parts.slice(line + 1).join(''), 'data', 'jsonl', BigInt(artifact.mtime_ns), step.at)
    steps.splice(index + 1, 0, { ...step, source })
    locate()
  }
  const remember = (file: string, change: Change): void => {
    const previous = change.append ? lines.get(file) : undefined
    const hash = previous?.hash ?? createHash('sha256')
    hash.update(change.content)
    const tail = Buffer.concat([previous?.tail ?? Buffer.alloc(0), change.content.subarray(-tailLength)]).subarray(-tailLength)
    lines.set(file, { length: (previous?.length ?? 0) + change.content.length, tail: Buffer.from(tail), hash })
  }
  const appended = async (file: string, size: number, previous: Lines): Promise<Buffer | undefined> => {
    if (size < previous.length) return undefined
    const bytes = await readRange(file, previous.length - previous.tail.length, size)
    return bytes.subarray(0, previous.tail.length).equals(previous.tail) ? bytes.subarray(previous.tail.length) : undefined
  }
  const linesChange = async (file: string, size: number, final: boolean): Promise<Change> => {
    const previous = lines.get(file)
    const fresh = final || previous === undefined ? undefined : await appended(file, size, previous)
    if (fresh !== undefined) return { append: true, content: decoded(jsonLines(fresh, false)) }
    const complete = decoded(jsonLines(await readFile(file), final))
    if (previous === undefined) return { append: true, content: complete }
    const prefix = complete.length >= previous.length && digestOf(complete.subarray(0, previous.length)) === previous.hash.copy().digest('hex')
    return prefix ? { append: true, content: complete.subarray(previous.length) } : { append: false, content: complete }
  }
  const documentChange = async (file: string): Promise<Change | undefined> => {
    const bytes = decoded(await readFile(file))
    JSON.parse(bytes.toString('utf8'))
    return contents.get(file)?.equals(bytes) ? undefined : { append: false, content: bytes }
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
        const info = await stat(file, { bigint: true }).catch((error: unknown) => {
          if (isMissing(error)) return undefined
          throw error
        })
        if (info === undefined) continue
        const stamp = `${String(info.size)}:${String(info.mtimeNs)}`
        if (!final && seen.get(file) === stamp) continue
        const jsonl = file.endsWith('.jsonl')
        let change: Change | undefined
        try {
          change = jsonl ? await linesChange(file, Number(info.size), final) : await documentChange(file)
        } catch (error) {
          if (isMissing(error)) continue
          if (final) throw error
          continue
        }
        seen.set(file, stamp)
        if (change === undefined || (change.append && change.content.length === 0)) continue
        const target = { root: location.root, path: `${location.prefix}/${relative(location.directory, file).replaceAll('\\', '/')}` }
        const observed = at()
        const source = add(change.content.toString('utf8'), 'data', jsonl ? 'jsonl' : 'json', info.mtimeNs, observed)
        steps.push({ kind: change.append ? 'append' : 'write', at: observed, target, source })
        if (jsonl) remember(file, change)
        else contents.set(file, change.content)
        targets.set(file, target)
      }
    }
    for (const [file, target] of kept) {
      const result = await Promise.all([readFile(file), stat(file, { bigint: true })]).catch((error: unknown) => {
        if (isMissing(error)) return undefined
        throw error
      })
      if (result === undefined) continue
      const [bytes, info] = result
      present.add(file)
      if (contents.get(file)?.equals(bytes)) continue
      const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      const observed = at()
      steps.push({ kind: 'write', at: observed, target, source: add(content, 'data', extname(file).slice(1), info.mtimeNs, observed) })
      contents.set(file, bytes)
      targets.set(file, target)
    }
    for (const [file, target] of targets) {
      if (!present.has(file)) {
        steps.push({ kind: 'remove', at: at(), target })
        contents.delete(file)
        lines.delete(file)
        seen.delete(file)
        targets.delete(file)
      }
    }
    for (const event of await readSpool(spool, hooks)) {
      const observed = Math.max(0, Number(event.receivedAt / 1_000_000n) - started)
      const bytes = await readFile(join(spool, 'new', event.name))
      add(new TextDecoder('utf-8', { fatal: true }).decode(bytes), 'spool', 'spool', event.receivedAt, observed)
      const source = add(new TextDecoder('utf-8', { fatal: true }).decode(event.payload), 'data', 'json', event.receivedAt, observed)
      steps.push({ kind: 'hook', at: observed, source, ...event.header })
      hooks.add(event.name)
    }
    steps.sort((left, right) => left.at - right.at)
    locate()
  }
  const created = async (): Promise<CreatedEntries> => {
    const ids = new Set<string>()
    const paths = new Set<string>()
    const unreadable = new Set<string>()
    const readable = <T>(path: string, read: Promise<T>, fallback: T): Promise<T> => read.catch(() => {
      unreadable.add(path)
      return fallback
    })
    const listing = (directory: string): Promise<Dirent[]> => readable(directory, entriesOf(directory), [])
    if (claudeRegular) {
      const projects = join(roots.claude, 'projects')
      for (const { name } of (await listing(projects)).filter(({ name }) => ownProject(name))) {
        paths.add(join(projects, name))
        for (const entry of await listing(join(projects, name))) {
          const session = sessionOf(entry.name)
          if (session !== undefined) ids.add(session)
        }
      }
      for (const session of sessions) ids.add(session)
      for (const { name } of await listing(pluginData)) {
        if (ownPluginData(name) && !existingPluginData.has(name)) paths.add(join(pluginData, name))
      }
      for (const directory of await listing(roots.claude)) {
        if (!directory.isDirectory() || directory.name === 'projects') continue
        for (const { name } of await listing(join(roots.claude, directory.name))) {
          if ([...ids].some((id) => name.includes(id))) paths.add(join(roots.claude, directory.name, name))
        }
      }
    }
    for (const [file, root] of owned) {
      if (!await readable(file, exists(file), true)) continue
      paths.add(file)
      const thread = root === 'codex' ? fieldsOf(fieldsOf(firstLine(await readable(file, readBytes(file), Buffer.alloc(0))))?.['payload'])?.['id'] : undefined
      if (typeof thread === 'string') ids.add(thread)
    }
    return { sessions: [...ids].sort(), paths: [...paths].sort(), unreadable: [...unreadable].sort() }
  }
  return {
    artifacts, steps, controlEvents, scan, created,
    keep: async (target) => {
      const segments = target.path.split('/')
      if (!target.path.endsWith('.toml') || !segments.every((segment) => Segment.safeParse(segment).success)) {
        throw new Error('A kept file must be a TOML file inside its root')
      }
      const file = join(roots[target.root], ...segments)
      if (!(await lstat(file)).isFile()) throw new Error('A kept file must be a regular file')
      kept.set(file, target)
      await scan(true)
    },
    checkpoint: async (label, target, expectedMapChange) => {
      await scan(true)
      const content = (step: PlayerStep): string | undefined => 'source' in step ? bySource.get(step.source)?.content : undefined
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
      if (!('hook' in target) && target.contains !== undefined) splitAfter(index, step, target.contains, target.occurrence)
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
