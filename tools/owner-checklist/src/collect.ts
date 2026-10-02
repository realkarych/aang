import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { anonymizeDeep, createAnonymizer } from './anonymize.js'
import { type ChecklistEvent, checklistEvent, isoTime } from './events.js'
import { inspectSessionFiles, type RootOverrides, type Roots, resolveRoots, type SessionFiles } from './files.js'
import { type ChecklistLayout, checklistLayout, outsideProbeDir } from './layout.js'
import type { EnvProbeRecord } from './probe-env.js'
import { scopeEvents } from './scope.js'
import { groupSessions } from './sessions.js'
import { readSpool } from './spool.js'
import { type ChecklistState, readState } from './state.js'
import { renderSummary } from './summary.js'

export interface CollectOptions {
  readonly dir: string
  readonly roots: RootOverrides
  readonly allSessions: boolean
}

export interface Collected {
  readonly layout: ChecklistLayout
  readonly state: ChecklistState
  readonly roots: Roots
  readonly events: readonly ChecklistEvent[]
  readonly droppedEvents: number
  readonly droppedSessions: number
  readonly files: SessionFiles
}

const eventRecord = (event: ChecklistEvent): Record<string, unknown> => ({
  received_at: isoTime(event.receivedNs),
  received_ns: event.receivedNs.toString(),
  runtime: event.runtime,
  registration: event.registration,
  hook_event_name: event.event,
  session_id: event.sessionId,
  env: event.env,
  ...event.fields,
  spool_file: event.file,
  ...(event.problem === null ? {} : { problem: event.problem }),
})

const readEnvProbes = async (path: string): Promise<EnvProbeRecord[]> => {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return []
  }
  return text.split(/\r?\n/).flatMap((line) => {
    try {
      return line.trim() === '' ? [] : [JSON.parse(line) as EnvProbeRecord]
    } catch {
      return []
    }
  })
}

const publicFiles = (files: SessionFiles): unknown => ({
  claudeTranscripts: files.claudeTranscripts,
  codexRollouts: files.codexRollouts,
  desktopSessions: files.desktopSessions.map((meta) => ({
    file: meta.file,
    sessionId: meta.sessionId,
    cliSessionId: meta.cliSessionId,
    lastSpawnRootDetected: meta.lastSpawnRootDetected,
    spawnSeed: meta.spawnSeed,
    shape: meta.shape,
  })),
  desktopDeleted: files.desktopDeleted.map((marker) => ({
    file: marker.file,
    hostSessionId: marker.hostSessionId,
    content: marker.content,
  })),
})

export const loadCollected = async (dir: string, overrides: RootOverrides, allSessions: boolean): Promise<Collected> => {
  const state = await readState(checklistLayout(resolve(dir)))
  const layout = checklistLayout(state.dir)
  const roots = resolveRoots(overrides)
  const spooled = (await readSpool(layout.spoolReady)).map(checklistEvent)
  const scoped = allSessions
    ? { events: spooled, droppedEvents: 0, droppedSessions: 0 }
    : scopeEvents(spooled, [state.dir, join(roots.codexHome, 'worktrees')])
  const files = await inspectSessionFiles(roots, scoped.events, state.outsideDir ?? outsideProbeDir())
  return { layout, state, roots, ...scoped, files }
}

export const collect = async ({ dir, roots: overrides, allSessions }: CollectOptions): Promise<string[]> => {
  const { layout, state, roots, events, droppedEvents, droppedSessions, files } = await loadCollected(
    dir,
    overrides,
    allSessions,
  )
  const anonymize = createAnonymizer(state.dir)
  const envProbes = await readEnvProbes(layout.envProbeLog)
  await mkdir(layout.results, { recursive: true })
  const eventsFile = join(layout.results, 'events.jsonl')
  const filesFile = join(layout.results, 'files.json')
  const summaryFile = join(layout.results, 'summary.md')
  await writeFile(
    eventsFile,
    events.map((event) => `${JSON.stringify(anonymizeDeep(eventRecord(event), anonymize))}\n`).join(''),
  )
  await writeFile(filesFile, `${JSON.stringify(anonymizeDeep(publicFiles(files), anonymize), null, 2)}\n`)
  await writeFile(
    summaryFile,
    `${renderSummary({
      generatedAt: new Date().toISOString(),
      state,
      events,
      scope: allSessions ? null : { droppedEvents, droppedSessions },
      sessions: groupSessions(events),
      envProbes: envProbes.map((probe) => anonymizeDeep(probe, anonymize) as EnvProbeRecord),
      files,
      codexHome: roots.codexHome,
      anonymize,
    })}\n`,
  )
  return [
    `Учтено событий: ${String(events.length)}; вне рабочего каталога отброшено событий: ${String(droppedEvents)} (сессий: ${String(droppedSessions)})`,
    `- ${eventsFile}`,
    `- ${filesFile}`,
    `- ${summaryFile}`,
    `- ${layout.envProbeLog}`,
    'Перед переносом в docs/research/ просмотрите файлы: пути обезличены, промпты и вывод инструментов не сохраняются.',
  ]
}
