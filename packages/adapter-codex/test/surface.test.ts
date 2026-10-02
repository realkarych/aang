import { readFileSync } from 'node:fs'
import { codexAdapter } from '@aang/adapter-codex'
import type { FactDraft, SurfaceClaim } from '@aang/contract'
import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import { factsOf, record, sampleObject, streamFrom } from './rollout-records.js'

const samplesRoot = new URL('../../../docs/research/samples/', import.meta.url)
const root = '01a0f800-0000-7000-8000-000000000001'
const child = '01a0f800-0000-7000-8000-000000000002'

type Classification =
  { readonly session: SurfaceClaim | null; readonly observer: boolean } | { readonly agent: 'subagent' | 'guardian' }

const observed = (surface: SurfaceClaim['surface']): SurfaceClaim => ({ surface, basis: 'observed' })
const assumed = (surface: SurfaceClaim['surface']): SurfaceClaim => ({ surface, basis: 'assumed' })
const session = (surface: SurfaceClaim | null, observer = false): Classification => ({ session: surface, observer })

const classificationOf = (facts: readonly FactDraft[]): Classification => {
  const [fact, ...rest] = facts
  expect(rest).toEqual([])
  if (fact?.kind === 'session_start') {
    return { session: fact.payload.surface, observer: fact.payload.observer_marker }
  }
  if (fact?.kind === 'agent_start') {
    return { agent: fact.payload.service === 'guardian' ? 'guardian' : 'subagent' }
  }
  throw new Error(`session_meta yielded ${fact?.kind ?? 'nothing'}`)
}

const classify = (line: string): Classification =>
  classificationOf(factsOf(codexAdapter.parse(record(line, streamFrom(line)))))

const sampleMeta = (path: string): string =>
  JSON.stringify(JSON.parse(readFileSync(new URL(path, samplesRoot), 'utf8')))

const SubagentKind = z.enum(['thread_spawn', 'other'])

const MetaSource = z.union([z.string(), z.strictObject({ subagent: SubagentKind })])
type MetaSource = z.infer<typeof MetaSource>

interface MetaShape {
  readonly originator: string
  readonly source: MetaSource
  readonly thread_source: string
}

const sourceLabel = (source: MetaSource): string => (typeof source === 'string' ? source : source.subagent)

const shapeLabel = ({ originator, source, thread_source: threadSource }: MetaShape): string =>
  `${originator} | ${sourceLabel(source)} | ${threadSource}`

const metaLine = (shape: MetaShape): string => {
  const base = sampleObject('session_meta.exec.real.json')
  const thread = typeof shape.source === 'string' ? { id: root, session_id: root } : { id: child, session_id: root }
  const source =
    typeof shape.source === 'string'
      ? shape.source
      : shape.source.subagent === 'thread_spawn'
        ? { subagent: { thread_spawn: { parent_thread_id: root, depth: 1 } } }
        : { subagent: { other: 'guardian' } }
  return JSON.stringify({
    ...base,
    payload: {
      ...z.record(z.string(), z.unknown()).parse(base['payload']),
      ...thread,
      originator: shape.originator,
      source,
      thread_source: shape.thread_source,
    },
  })
}

test('session_meta samples of the SDK and app-server clients are classified by originator and source', () => {
  expect(
    Object.fromEntries(
      [
        'codex-sdk/rollout-session-meta.sdk-parent.json',
        'codex-sdk/rollout-session-meta.sdk-subagent.json',
        'codex-app-server/rollout-session-meta.app-server-stdio.json',
        'codex-app-server/rollout-session-meta.tui-on-daemon.json',
      ].map((path) => [path, classify(sampleMeta(path))]),
    ),
  ).toEqual({
    'codex-sdk/rollout-session-meta.sdk-parent.json': session(observed('codex_sdk')),
    'codex-sdk/rollout-session-meta.sdk-subagent.json': { agent: 'subagent' },
    'codex-app-server/rollout-session-meta.app-server-stdio.json': session(null),
    'codex-app-server/rollout-session-meta.tui-on-daemon.json': session(null),
  })
})

describe('every originator × source combination seen in real rollouts', () => {
  const Stats = z.looseObject({
    by_originator_source_threadsource_version: z.array(
      z.looseObject({ originator: z.string(), source: MetaSource, thread_source: z.string() }),
    ),
  })
  const stats = Stats.parse(
    JSON.parse(readFileSync(new URL('desktop/codex-originator-stats.json', samplesRoot), 'utf8')),
  )
  const seen = new Map(stats.by_originator_source_threadsource_version.map((shape) => [shapeLabel(shape), shape]))
  const expected: Readonly<Record<string, Classification>> = {
    'codex-tui | cli | user': session(assumed('codex_tui')),
    'codex-tui | thread_spawn | subagent': { agent: 'subagent' },
    'codex_exec | exec | user': session(observed('codex_exec')),
    'Codex Desktop | vscode | user': session(assumed('codex_desktop')),
    'Codex Desktop | thread_spawn | subagent': { agent: 'subagent' },
    'Codex Desktop | other | guardian_review': { agent: 'guardian' },
    'aang_observer | exec | aang-observer': session(null, true),
  }

  test('has a classification', () => {
    expect([...seen.keys()].sort()).toEqual(Object.keys(expected).sort())
  })

  test.each(Object.entries(expected))('%s', (label, classification) => {
    const shape = seen.get(label)
    expect(shape).toBeDefined()
    expect(shape === undefined ? null : classify(metaLine(shape))).toEqual(classification)
  })
})

test.each<[string, MetaShape, Classification]>([
  [
    'a TUI thread on the shared daemon it started is still only an assumed TUI',
    { originator: 'codex-tui', source: 'vscode', thread_source: 'user' },
    session(assumed('codex_tui')),
  ],
  [
    'the SDK originator outside exec is not taken for the SDK',
    { originator: 'codex_sdk_ts', source: 'vscode', thread_source: 'user' },
    session(null),
  ],
  [
    'the exec originator outside exec is not taken for exec',
    { originator: 'codex_exec', source: 'cli', thread_source: 'user' },
    session(null),
  ],
  [
    'an exec session whose originator the application replaced has no surface',
    { originator: 'my_app', source: 'exec', thread_source: 'user' },
    session(null),
  ],
  [
    'an observer launched with its thread source keeps the exec surface and is marked',
    { originator: 'codex_exec', source: 'exec', thread_source: 'aang-observer' },
    session(observed('codex_exec'), true),
  ],
])('%s', (_name, shape, classification) => {
  expect(classify(metaLine(shape))).toEqual(classification)
})

test('app-server clients named like Desktop without its environment override are not taken for Desktop', () => {
  const Experiment = z.looseObject({
    rollouts_in_run_order: z.array(z.looseObject({ originator: z.string(), source: z.string() })),
  })
  const experiment = Experiment.parse(
    JSON.parse(readFileSync(new URL('desktop/exp-codex-desktop-originator.json', samplesRoot), 'utf8')),
  )

  expect(experiment.rollouts_in_run_order.map(({ originator }) => originator)).toEqual([
    'Codex',
    'Codex',
    'Codex',
    'codex_desktop',
  ])
  for (const { originator, source } of experiment.rollouts_in_run_order) {
    expect(classify(metaLine({ originator, source, thread_source: 'user' }))).toEqual(session(null))
  }
})
