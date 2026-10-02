import { existsSync, type FSWatcher, watch } from 'node:fs'
import { mkdir, readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { claudeAdapter } from '@aang/adapter-claude'
import { codexAdapter } from '@aang/adapter-codex'
import { createCollector } from '@aang/collector'
import { type Adapter, type CollectedGap, type CollectedRecord, Config, type Runtime } from '@aang/contract'
import { claudeOutcome, runClaude } from './claude.js'
import { codexOutcome, type CommandForm, newPatch, runCodex, writeCodexHome } from './codex.js'
import type { CheckContext } from './context.js'
import { allEventHooks } from './latency.js'
import { filesUnder, spoolReady } from './profile.js'
import { errorCode, excerpt } from './process.js'

interface WatchStats {
  readonly directory: string
  events: number
  nullNames: number
  readonly names: Set<string>
  readonly errors: string[]
}

interface ReadStats {
  reads: number
  readonly failures: Record<string, number>
}

interface ChannelStats {
  records: number
  readonly states: Record<string, number>
  readonly facts: Record<string, number>
  readonly invalid: string[]
}

const adapters: Readonly<Record<Runtime, Adapter>> = { claude: claudeAdapter, codex: codexAdapter }

const watchRaw = (directory: string): { readonly stats: WatchStats; readonly close: () => void } => {
  const stats: WatchStats = { directory, events: 0, nullNames: 0, names: new Set(), errors: [] }
  let watcher: FSWatcher | null = null
  try {
    watcher = watch(directory, { recursive: true, encoding: 'utf8' }, (_event, name) => {
      stats.events += 1
      if (name === null) {
        stats.nullNames += 1
      } else {
        stats.names.add(name)
      }
    })
    watcher.on('error', (error) => {
      stats.errors.push(errorCode(error))
    })
  } catch (error) {
    stats.errors.push(errorCode(error))
  }
  return { stats, close: () => watcher?.close() }
}

const pollReads = (roots: readonly string[]): { readonly stats: ReadStats; readonly stop: () => void } => {
  const stats: ReadStats = { reads: 0, failures: {} }
  let files: string[] = []
  let busy = false
  let tick = 0
  const poll = async (): Promise<void> => {
    if (tick % 10 === 0) {
      files = (await Promise.all(roots.map(filesUnder))).flat().filter((file) => file.endsWith('.jsonl'))
    }
    tick += 1
    for (const file of files) {
      try {
        await readFile(file)
        stats.reads += 1
      } catch (error) {
        const code = errorCode(error)
        stats.failures[code] = (stats.failures[code] ?? 0) + 1
      }
    }
  }
  const timer = setInterval(() => {
    if (!busy) {
      busy = true
      void poll().finally(() => {
        busy = false
      })
    }
  }, 50)
  return {
    stats,
    stop: () => {
      clearInterval(timer)
    },
  }
}

const withStreams = async (records: readonly CollectedRecord[]): Promise<CollectedRecord[]> => {
  const streams = new Map<string, CollectedRecord['stream']>()
  const assigned: CollectedRecord[] = []
  for (const record of records) {
    if (record.position.kind !== 'line') {
      assigned.push(record)
      continue
    }
    const { path } = record.position
    if (!streams.has(path)) {
      const firstLines = (await readFile(path, 'utf8').catch(() => '')).split(/\r?\n/).slice(0, 8)
      streams.set(path, adapters[record.runtime].streamKey(firstLines))
    }
    assigned.push({ ...record, stream: record.stream ?? streams.get(path) ?? null })
  }
  return assigned
}

const analyse = (records: readonly CollectedRecord[]): Record<string, ChannelStats> => {
  const channels: Record<string, ChannelStats> = {}
  for (const record of records) {
    const key = `${record.runtime}/${record.channel}`
    const stats = (channels[key] ??= { records: 0, states: {}, facts: {}, invalid: [] })
    stats.records += 1
    let state: string
    try {
      const result = adapters[record.runtime].parse(record)
      state = result.parse_state
      if (result.parse_state === 'parsed') {
        for (const fact of result.facts) {
          stats.facts[fact.kind] = (stats.facts[fact.kind] ?? 0) + 1
        }
      } else if (result.parse_state === 'invalid' && stats.invalid.length < 5) {
        stats.invalid.push(`${result.reason}: ${excerpt(record.payload, 300)}`)
      }
    } catch (error) {
      state = 'threw'
      if (stats.invalid.length < 5) {
        stats.invalid.push(`threw ${errorCode(error)}`)
      }
    }
    stats.states[state] = (stats.states[state] ?? 0) + 1
  }
  return channels
}

const field = (payload: string, name: string): unknown => {
  try {
    const value: unknown = JSON.parse(payload)
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[name] : undefined
  } catch {
    return undefined
  }
}

const hookPaths = (records: readonly CollectedRecord[], runtime: Runtime): Record<string, unknown>[] => {
  const seen = new Set<string>()
  const samples: Record<string, unknown>[] = []
  for (const record of records.filter((candidate) => candidate.channel === 'hook' && candidate.runtime === runtime)) {
    const transcript = field(record.payload, 'transcript_path')
    const cwd = field(record.payload, 'cwd')
    const key = `${String(transcript)}|${String(cwd)}`
    if (!seen.has(key) && samples.length < 3) {
      seen.add(key)
      samples.push({
        event: field(record.payload, 'hook_event_name'),
        cwd,
        transcript_path: transcript,
        transcriptExists: typeof transcript === 'string' ? existsSync(transcript) : null,
        headerEnv: record.hook?.env ?? null,
      })
    }
  }
  return samples
}

const lineStats = async (files: readonly string[]): Promise<Record<string, number>> => {
  let lines = 0
  let crlf = 0
  for (const file of files) {
    const text = await readFile(file, 'utf8')
    lines += text.split('\n').length - 1
    crlf += text.split('\r\n').length - 1
  }
  return { files: files.length, lines, crlf }
}

const firstValue = async (
  files: readonly string[],
  pick: (line: Record<string, unknown>) => unknown,
): Promise<unknown> => {
  for (const file of files) {
    for (const line of (await readFile(file, 'utf8')).split('\n')) {
      try {
        const value = pick(JSON.parse(line) as Record<string, unknown>)
        if (value !== undefined) {
          return value
        }
      } catch {
        continue
      }
    }
  }
  return null
}

const listNames = async (directory: string): Promise<string[]> => {
  try {
    return (await readdir(directory)).sort()
  } catch {
    return []
  }
}

const claudeFiles = async (configDir: string): Promise<Record<string, unknown>> => {
  const projects = join(configDir, 'projects')
  const transcripts = (await filesUnder(projects)).filter((file) => file.endsWith('.jsonl'))
  return {
    projectDirectories: await listNames(projects),
    transcriptSamples: transcripts.slice(0, 3).map((file) => relative(configDir, file)),
    lineEndings: await lineStats(transcripts),
    cwd: await firstValue(transcripts, (line) => line.cwd),
    registry: await listNames(join(configDir, 'sessions')),
    configFiles: await listNames(configDir),
  }
}

const codexFiles = async (home: string): Promise<Record<string, unknown>> => {
  const rollouts = (await filesUnder(join(home, 'sessions'))).filter((file) => file.endsWith('.jsonl'))
  return {
    rolloutSamples: rollouts.slice(0, 3).map((file) => relative(home, file)),
    lineEndings: await lineStats(rollouts),
    cwd: await firstValue(rollouts, (line) =>
      line.type === 'session_meta' && typeof line.payload === 'object' && line.payload !== null
        ? (line.payload as Record<string, unknown>).cwd
        : undefined,
    ),
    homeFiles: await listNames(home),
  }
}

const watchSummary = ({ directory, events, nullNames, names, errors }: WatchStats): Record<string, unknown> => ({
  directory,
  events,
  nullNames,
  distinctNames: names.size,
  sampleNames: [...names].slice(0, 5),
  errors,
})

export const pipelineCheck = async (
  context: CheckContext,
  form: CommandForm | null,
): Promise<Record<string, unknown>> => {
  const { profile } = context
  const codexHome = join(context.work, 'codex-pipeline')
  await writeCodexHome(context, codexHome, form === null ? null : allEventHooks(context, form))
  const claudeProjects = join(profile.claudeConfigDir, 'projects')
  const codexSessions = join(codexHome, 'sessions')
  await mkdir(claudeProjects, { recursive: true })
  await mkdir(codexSessions, { recursive: true })
  const watchers = [watchRaw(claudeProjects), watchRaw(codexSessions), watchRaw(spoolReady(profile.spool))]
  const reads = pollReads([claudeProjects, codexSessions])
  const collector = createCollector({
    spool: profile.spool,
    runtimeRoots: { claude: profile.claudeConfigDir, codex: codexHome },
    config: Config.parse({ collector: { spoolScanIntervalMs: 1_000, rootsScanIntervalMs: 2_000 } }),
  })
  const records: CollectedRecord[] = []
  const gaps: CollectedGap[] = []
  let lastBatchAt = Date.now()
  const consuming = (async () => {
    for await (const batch of collector.start([])) {
      records.push(...batch.records)
      gaps.push(...batch.gaps)
      lastBatchAt = Date.now()
      await collector.ack(batch)
    }
  })()
  const claude = await runClaude(context, { steps: 3 })
  const codex = await runCodex(context, {
    home: codexHome,
    steps: [newPatch(context, 'pipeline').step, newPatch(context, 'pipeline').step],
  })
  const finishedAt = Date.now()
  while (Date.now() - finishedAt < 30_000 && (Date.now() - lastBatchAt < 4_000 || Date.now() - finishedAt < 6_000)) {
    await sleep(250)
  }
  await collector.close()
  await consuming
  reads.stop()
  for (const watcher of watchers) {
    watcher.close()
  }
  const assigned = await withStreams(records)
  const lineRecords = assigned.filter((record) => record.position.kind === 'line')
  const sourceFiles = (await Promise.all([claudeProjects, codexSessions].map(filesUnder))).flat().filter((file) => file.endsWith('.jsonl'))
  const allFileLinesCollected = (await Promise.all(sourceFiles.map(async (file) => {
    const expected = (await readFile(file, 'utf8')).split('\n').filter((line) => line.trim() !== '').length
    return expected === lineRecords.filter((record) => record.position.kind === 'line' && record.position.path === file).length
  }))).every(Boolean)
  return {
    sessions: { claude: claudeOutcome(claude), codex: codexOutcome(codex) },
    collector: {
      records: records.length,
      channels: analyse(assigned),
      allFileLinesCollected,
      gaps: gaps.map(({ key, details }) => ({ key, details })),
      spoolLeft: (await listNames(spoolReady(profile.spool))).length,
    },
    hookPayloadPaths: { claude: hookPaths(records, 'claude'), codex: hookPaths(records, 'codex') },
    files: { claude: await claudeFiles(profile.claudeConfigDir), codex: await codexFiles(codexHome) },
    fsWatch: watchers.map(({ stats }) => watchSummary(stats)),
    concurrentReads: reads.stats,
  }
}
