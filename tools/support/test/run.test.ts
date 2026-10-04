import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ActionId,
  EpochNs,
  type Link,
  LinkId,
  ModelVersion,
  StageId,
  type SupportKey,
  type SupportMatrix,
  supportMatrixFormat,
  type SupportRow,
  supportRowOf,
  supportStatusOf,
} from '@aang/contract'
import { readSupportMatrix } from '@aang/contract/support-file'
import { loadManifest } from '@aang/testkit'
import { beforeAll, describe, expect, onTestFinished, test } from 'vitest'
import {
  checkRecording,
  findRecordings,
  invariantViolations,
  matrixPath,
  notRestarted,
  playRecording,
  type RecordingCheck,
  removeRoots,
  snapshotFile,
  supportGaps,
  takeSnapshot,
} from '../dist/index.js'
import {
  claudeReconnect,
  claudeSourceLoss,
  claudeSubagents,
  cliOptions,
  codexResumeCompaction,
  codexToolDecisions,
  hookBinary,
  hostOs,
  otherOs,
  placeRecording,
  recordSpike,
  type SpikeRecording,
  supportCli,
  temporaryDirectory,
  thirdOs,
  withoutCheckpoints,
} from './fixtures.js'

interface Snapshot {
  readonly facts: readonly { readonly kind: string }[]
  readonly sessions: readonly { readonly id: string }[]
  readonly gaps: readonly { readonly kind: string; readonly closed_at: string | null }[]
  readonly agents: readonly {
    readonly id: string
    readonly session: string
    readonly role: string
    readonly agent_type: string | null
    readonly description: string | null
    readonly parent: string | null
  }[]
  readonly actions: readonly { readonly tool: string; readonly session: string; readonly execution: { readonly state: string } }[]
  readonly records: readonly { readonly channel: string; readonly parse_state: string; readonly count: number }[]
  readonly questions: readonly { readonly kind: string; readonly key: { readonly question: string } }[]
}

const generated = new Map<SpikeRecording, string>()

const recorded = (recording: SpikeRecording): string => {
  const directory = generated.get(recording)
  if (directory === undefined) {
    throw new Error(`${recording.scenario} is not recorded`)
  }
  return directory
}

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), 'aang-support-generated-'))
  for (const recording of [claudeSubagents, claudeReconnect, claudeSourceLoss, codexResumeCompaction, codexToolDecisions]) {
    generated.set(recording, await recordSpike(join(root, 'sessions'), recording))
  }
  return () => rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
}, 180_000)

const workspace = async (): Promise<{ readonly sessions: string; readonly support: string }> => {
  const root = await temporaryDirectory((cleanup) => { onTestFinished(cleanup) }, 'aang-support-run-')
  return { sessions: join(root, 'sessions'), support: join(root, 'support') }
}

const readSnapshot = async (path: string): Promise<Snapshot> => JSON.parse(await readFile(path, 'utf8')) as Snapshot

describe('the contract run over recordings generated from the spike samples', () => {
  test('update stores one snapshot per recording and OS, and check reproduces them', async () => {
    const { sessions, support } = await workspace()
    await placeRecording(recorded(claudeSubagents), sessions, { os: hostOs })
    await placeRecording(recorded(claudeSubagents), sessions, { os: otherOs })
    await placeRecording(recorded(claudeSourceLoss), sessions)
    await placeRecording(recorded(codexResumeCompaction), sessions)
    await placeRecording(recorded(codexToolDecisions), sessions)

    const update = await supportCli(['update', ...cliOptions(sessions, support)])
    expect(update.stderr).toBe('')
    expect(update.code).toBe(0)

    expect((await findRecordings(sessions)).map(({ name }) => name).sort()).toEqual(
      [
        `claude/2.1.286/claude_cli/${hostOs}/source-loss`,
        `claude/2.1.286/claude_cli/${hostOs}/subagents`,
        `claude/2.1.286/claude_cli/${otherOs}/subagents`,
        `codex/0.159.2/codex_exec/${hostOs}/resume-compaction`,
        `codex/0.159.2/codex_exec/${hostOs}/tools`,
      ].sort(),
    )
    const snapshotText = (path: string): Promise<string> => readFile(join(support, 'contract', `${path}.json`), 'utf8')
    const host = await snapshotText(`claude/2.1.286/claude_cli/${hostOs}/subagents`)
    expect(await snapshotText(`claude/2.1.286/claude_cli/${otherOs}/subagents`)).toBe(host)
    const claude = JSON.parse(host) as Snapshot
    expect(claude.agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'main', parent: null }),
        expect.objectContaining({ role: 'subagent', agent_type: 'pinger' }),
      ]),
    )
    expect(claude.records).toEqual(expect.arrayContaining([expect.objectContaining({ channel: 'hook', parse_state: 'parsed' })]))
    expect(claude.questions.map(({ kind }) => kind)).toEqual(['permission'])
    expect(claude.questions[0]?.key.question).toMatch(/^spool#\d+$/)
    expect(host).not.toMatch(/[0-9]{19}-[A-Z0-9]{26}/)
    const lost = JSON.parse(await snapshotText(`claude/2.1.286/claude_cli/${hostOs}/source-loss`)) as Snapshot
    expect(lost.gaps).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'source_lost', closed_at: null })]))
    expect(lost.records).toEqual(expect.arrayContaining([expect.objectContaining({ channel: 'registry', parse_state: 'parsed', count: 3 })]))
    const resumed = JSON.parse(await snapshotText(`codex/0.159.2/codex_exec/${hostOs}/resume-compaction`)) as Snapshot
    expect(resumed.facts.map(({ kind }) => kind)).toEqual(expect.arrayContaining(['compaction', 'usage', 'usage_total']))
    const decisions = JSON.parse(await snapshotText(`codex/0.159.2/codex_exec/${hostOs}/tools`)) as Snapshot
    expect(decisions.records).toEqual([expect.objectContaining({ channel: 'otel', count: 15 })])

    const check = await supportCli(['check', ...cliOptions(sessions, support)])
    expect(check.stdout).toBe('5 recordings, 0 problems\n')
    expect(check.code).toBe(0)
  }, 120_000)

  test('recordings generated from the spike samples on macOS replay to their committed snapshots on every OS', async () => {
    const portable = fileURLToPath(new URL('./portable/', import.meta.url))

    const check = await supportCli(['check', ...cliOptions(join(portable, 'sessions'), join(portable, 'support'))])

    expect(check).toEqual({ code: 0, stdout: '4 recordings, 0 problems\n', stderr: '' })
  }, 120_000)

  test('the run refuses an unknown command, a recording outside its own directory and a missing hook binary', async () => {
    const { sessions, support } = await workspace()
    const usage = await supportCli(['verify'])
    expect(usage.code).toBe(2)
    expect(usage.stderr).toMatch(/^Usage:/)

    const placed = await placeRecording(recorded(claudeSubagents), sessions, { os: hostOs })
    const misplaced = join(dirname(placed), 'tools')
    await cp(placed, misplaced, { recursive: true })
    const mismatch = await supportCli(['check', ...cliOptions(sessions, support)])
    expect(mismatch.code).toBe(1)
    expect(mismatch.stderr).toContain(`the manifest describes claude/2.1.286/claude_cli/${hostOs}/subagents`)
    await rm(misplaced, { recursive: true })

    const noHook = await supportCli(['check', '--fixtures', sessions, '--support', support, '--hook', join(support, 'aang-hook-missing')])
    expect(noHook.code).toBe(1)
    expect(noHook.stderr).toMatch(/step \d+ \(hook "contract-step-\d+"\) failed: spawn .*aang-hook-missing/)
  }, 120_000)

  test('a changed snapshot, a missing or stale snapshot and an outdated matrix fail the check', async () => {
    const { sessions, support } = await workspace()
    await placeRecording(recorded(claudeSubagents), sessions, { os: hostOs })
    await placeRecording(recorded(codexResumeCompaction), sessions)
    expect((await supportCli(['update', ...cliOptions(sessions, support)])).code).toBe(0)
    const [claude, codex] = await findRecordings(sessions)
    if (claude === undefined || codex === undefined) {
      throw new Error('the recordings are not found')
    }
    const claudeSnapshot = snapshotFile(support, claude)
    const stored = await readSnapshot(claudeSnapshot)
    await writeFile(claudeSnapshot, `${JSON.stringify({ ...stored, facts: stored.facts.slice(1) }, null, 2)}\n`)
    await rm(snapshotFile(support, codex))
    const stale = join(support, 'contract/claude/2.1.286/claude_cli', hostOs, 'interrupt.json')
    await writeFile(stale, '{}\n')
    const matrix = await readSupportMatrix(matrixPath(support))
    await writeFile(matrixPath(support), `${JSON.stringify({ ...matrix, rows: matrix.rows.slice(1) }, null, 2)}\n`)

    const check = await supportCli(['check', ...cliOptions(sessions, support)])

    expect(check.code).toBe(1)
    expect(check.stdout.split('\n')).toEqual([
      `${claude.name}: the snapshot differs`,
      `${codex.name}: no stored snapshot`,
      join('contract/claude/2.1.286/claude_cli', hostOs, 'interrupt.json') + ': no recording in the contract run',
      'matrix.json does not match the contract run',
      '2 recordings, 4 problems',
      '',
    ])
  }, 120_000)

  test('a reconnect recording restarts the collector, the engine and the store at its daemon-restart step, and the restart changes nothing in the snapshot', async () => {
    const { sessions, support } = await workspace()
    await placeRecording(recorded(claudeReconnect), sessions)
    await withoutCheckpoints(await placeRecording(recorded(claudeReconnect), sessions, { scenario: 'tools' }))
    const recordings = await findRecordings(sessions)
    const run = (scenario: string): Promise<RecordingCheck> => {
      const recording = recordings.find(({ manifest }) => manifest.scenario === scenario)
      if (recording === undefined) {
        throw new Error(`${scenario} is not placed`)
      }
      return checkRecording(recording, { sessions, support, hookBinary })
    }

    const restarted = await run('reconnect')
    const continuous = await run('tools')

    expect(restarted).toMatchObject({ restarts: 1, violations: [] })
    expect(continuous).toMatchObject({ restarts: 0, violations: [] })
    expect(restarted.snapshot).toBe(continuous.snapshot)
    const snapshot = JSON.parse(restarted.snapshot) as Snapshot
    const [session] = snapshot.sessions
    expect(snapshot.sessions).toHaveLength(1)
    const main = snapshot.agents.find(({ role }) => role === 'main')
    expect(snapshot.agents).toEqual([
      expect.objectContaining({ role: 'main', session: session?.id, parent: null }),
      expect.objectContaining({ role: 'subagent', session: session?.id, agent_type: 'pinger', parent: main?.id }),
    ])
    expect(snapshot.actions.filter(({ tool }) => tool === 'Bash')).toEqual([
      expect.objectContaining({ session: session?.id, execution: { state: 'done' } }),
    ])
  }, 120_000)

  test('a reconnect recording without a daemon-restart step fails the run, and update refuses to write', async () => {
    const { sessions, support } = await workspace()
    await placeRecording(recorded(claudeSubagents), sessions, { scenario: 'reconnect' })

    const update = await supportCli(['update', ...cliOptions(sessions, support)])

    expect(update.code).toBe(1)
    expect(update.stderr).toContain(`claude/2.1.286/claude_cli/${hostOs}/reconnect: ${notRestarted}`)
    await expect(readFile(matrixPath(support), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  }, 120_000)

  test('a JSONL file under tool-results, which the collector leaves out, does not hold up the run', async () => {
    const { sessions, support } = await workspace()
    const placed = await placeRecording(recorded(claudeSubagents), sessions)
    const playback = JSON.parse(await readFile(join(placed, 'playback.json'), 'utf8')) as { steps: unknown[] }
    expect(playback.steps).toContainEqual(
      expect.objectContaining({ kind: 'append', target: { root: 'claude', path: expect.stringMatching(/\/tool-results\/output\.jsonl$/) as unknown } }),
    )

    const update = await supportCli(['update', ...cliOptions(sessions, support)])

    expect(update.stderr).toBe('')
    expect(update.code).toBe(0)
  }, 120_000)

  test('text shaped like an id stays content, while a model entity that refers to a missing derived or assigned id breaks an invariant', async () => {
    const { sessions } = await workspace()
    const placed = await placeRecording(recorded(claudeSubagents), sessions)
    const hashLike = 'd41d8cd98f00b204e9800998ecf8427e'
    for (const name of await readdir(join(placed, 'data'))) {
      const path = join(placed, 'data', name)
      await writeFile(path, (await readFile(path, 'utf8')).replaceAll('Ping the pinger agent', hashLike))
    }
    const { store, roots } = await playRecording(await loadManifest(join(placed, 'playback.json')), { hookBinary })
    onTestFinished(async () => {
      store.close()
      await removeRoots(roots)
    })

    expect(invariantViolations(store)).toEqual([])
    expect(takeSnapshot(store, roots.base).agents).toContainEqual(expect.objectContaining({ role: 'subagent', description: hashLike }))

    const [run] = store.model.runs()
    if (run === undefined) {
      throw new Error('the recording has no run')
    }
    const missingAction = ActionId.parse('0123456789abcdef0123456789abcdef')
    const missingStage = StageId.parse('stage:missing')
    const link: Link = {
      id: LinkId.parse('link:dangling'),
      run: run.id,
      basis: { kind: 'observed' },
      evidence: [],
      kind: 'assignment',
      action: missingAction,
      stage: missingStage,
    }
    store.transaction((transaction) => {
      const version = ModelVersion.parse(transaction.model.head(run.id) + 1)
      transaction.model.commit(
        {
          run: run.id,
          version,
          base_version: ModelVersion.parse(version - 1),
          author: 'rule',
          observer_call: null,
          created_at: EpochNs.parse(1n),
          change_seq: transaction.nextChangeSeq(),
        },
        [{ op: 'link.add', target: { kind: 'link', id: link.id }, before: null, after: { kind: 'link', value: link }, basis: link.basis, evidence: [] }],
      )
    })

    expect(invariantViolations(store)).toEqual([
      `link.value.action refers to ${missingAction}, which is not stored`,
      `link.value.stage refers to ${missingStage}, which is not stored`,
    ])
  }, 120_000)

  test('a thread whose usage records do not add up to its thread total breaks an invariant, and update refuses to write', async () => {
    const { sessions, support } = await workspace()
    const placed = await placeRecording(recorded(codexResumeCompaction), sessions)
    const [recording] = await findRecordings(sessions)
    const playback = JSON.parse(await readFile(join(placed, 'playback.json'), 'utf8')) as {
      steps: { kind: string; source?: string }[]
    }
    const rollouts = playback.steps.flatMap((step) => (step.kind === 'append' && step.source !== undefined ? [step.source] : []))
    if (recording === undefined || rollouts.length === 0) {
      throw new Error('the Codex rollout is not recorded')
    }
    let inflatedRecords = 0
    for (const rollout of rollouts) {
      const lines = (await readFile(join(placed, rollout), 'utf8')).split('\n')
      const inflated = lines.map((line) =>
        line.includes('"token_usage_record"') ? line.replace(/"output_tokens":\s*(\d+)/, (_, tokens: string) => `"output_tokens":${String(Number(tokens) + 1000)}`) : line,
      )
      inflatedRecords += inflated.filter((line, index) => line !== lines[index]).length
      await writeFile(join(placed, rollout), inflated.join('\n'))
    }
    expect(inflatedRecords).toBeGreaterThan(0)

    const update = await supportCli(['update', ...cliOptions(sessions, support)])

    expect(update.code).toBe(1)
    expect(update.stderr).toMatch(new RegExp(`${recording.name}: thread [0-9a-f-]+: token_usage_record sum .* differs from the last thread_token_usage`))
    await expect(readFile(matrixPath(support), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  }, 120_000)
})

const notRunContract = { resume: 'not_run', compaction: 'not_run', child_sessions: 'not_run', reconnect: 'not_run' } as const

const readdirNames = async (directory: string): Promise<string[]> => (await readdir(directory)).sort()

const claimed = (key: SupportKey, status: SupportRow['status']): SupportRow => ({
  ...key,
  app_version: null,
  status,
  gaps: status === 'limited' ? ['owner checklist item g'] : [],
  scenarios: { ...notRunContract, during_work: 'passed', after_iteration: 'passed' },
  observer: { admission: 'passed', cross_session_inbound: 'passed', builtins: { mcp_servers: [], plugins: [], skills: [] } },
  verified_on: '2026-10-04',
})

const cliKey = (os: SupportKey['os'], placement: SupportKey['placement'] = 'local'): SupportKey => ({
  runtime: 'claude',
  surface: 'claude_cli',
  os,
  placement,
  engine_version: '2.1.286',
})

const desktopOnWindows: SupportKey = { ...cliKey('windows'), surface: 'claude_desktop' }

const contractScenarios = ['tools', 'subagents', 'resume', 'compaction', 'fork', 'plan', 'approval', 'question', 'interrupt', 'reconnect', 'source-loss']

describe('the support matrix generated from the contract run', () => {
  test('a row keeps its claimed status only while recordings of its own OS pass every scenario of the run', async () => {
    const { sessions, support } = await workspace()
    for (const scenario of contractScenarios) {
      await placeRecording(recorded(scenario === 'reconnect' ? claudeReconnect : claudeSubagents), sessions, { os: hostOs, scenario })
    }
    for (const scenario of ['plan', 'question']) {
      await placeRecording(recorded(codexToolDecisions), sessions, { os: hostOs, scenario })
    }
    await placeRecording(recorded(claudeSubagents), sessions, { os: otherOs, scenario: 'subagents' })
    const previous: SupportMatrix = {
      format: supportMatrixFormat,
      rows: [
        claimed(cliKey(hostOs), 'limited'),
        claimed(cliKey(otherOs), 'full'),
        claimed(cliKey(thirdOs), 'full'),
        claimed(cliKey('linux', 'docker'), 'full'),
        claimed(cliKey('macos', 'vm'), 'full'),
        claimed(cliKey('windows', 'desktop_ssh'), 'full'),
      ],
    }
    await mkdir(dirname(matrixPath(support)), { recursive: true })
    await writeFile(matrixPath(support), `${JSON.stringify(previous, null, 2)}\n`)

    expect((await supportCli(['update', ...cliOptions(sessions, support)])).code).toBe(0)
    const matrix = await readSupportMatrix(matrixPath(support))
    const row = (key: SupportKey): SupportRow | null => supportRowOf(matrix, key)

    expect(row(cliKey(hostOs))).toEqual({
      ...claimed(cliKey(hostOs), 'limited'),
      scenarios: { during_work: 'passed', after_iteration: 'passed', resume: 'passed', compaction: 'passed', child_sessions: 'passed', reconnect: 'passed' },
    })
    expect(row(cliKey(otherOs))).toMatchObject({
      status: 'unverified',
      gaps: [supportGaps.missing(contractScenarios.filter((name) => name !== 'subagents').sort())],
      scenarios: { child_sessions: 'passed', resume: 'not_run', during_work: 'passed' },
    })
    expect(row(cliKey(thirdOs))).toMatchObject({ status: 'unverified', gaps: [supportGaps.noRecordings], scenarios: notRunContract })
    for (const placed of [cliKey('linux', 'docker'), cliKey('macos', 'vm'), cliKey('windows', 'desktop_ssh')]) {
      expect(row(placed)?.status).toBe('unverified')
      expect(row(placed)?.gaps).toContain(supportGaps.placement)
    }
    expect(supportStatusOf(matrix, { ...cliKey(hostOs), engine_version: '2.1.287' })).toBe('unverified')
    expect(await readdirNames(join(support, 'contract/claude/2.1.286/claude_cli', hostOs))).toEqual(
      contractScenarios.map((name) => `${name}.json`).sort(),
    )
    expect(await readdirNames(join(support, 'contract'))).toEqual(['claude'])
  }, 180_000)

  test('a claimed full or limited row whose E2E 1 or 4 failed is not verified, even when every scenario of the run passes', async () => {
    const { sessions, support } = await workspace()
    const tuiKey = (engine_version: string): SupportKey => ({ runtime: 'codex', surface: 'codex_tui', os: hostOs, placement: 'local', engine_version })
    const variants = [
      { key: tuiKey('0.200.1'), status: 'full', failed: 'during_work', gap: 'E2E 1' },
      { key: tuiKey('0.200.2'), status: 'full', failed: 'after_iteration', gap: 'E2E 4' },
      { key: tuiKey('0.200.3'), status: 'limited', failed: 'during_work', gap: 'E2E 1' },
      { key: tuiKey('0.200.4'), status: 'limited', failed: 'after_iteration', gap: 'E2E 4' },
    ] as const
    for (const { key } of variants) {
      for (const scenario of ['tools', 'approval', 'interrupt']) {
        await placeRecording(recorded(codexResumeCompaction), sessions, { surface: key.surface, engineVersion: key.engine_version, scenario })
      }
    }
    const previous: SupportMatrix = {
      format: supportMatrixFormat,
      rows: variants.map(({ key, status, failed }) => {
        const row = claimed(key, status)
        return { ...row, scenarios: { ...row.scenarios, [failed]: 'failed' } }
      }),
    }
    await mkdir(support, { recursive: true })
    await writeFile(matrixPath(support), `${JSON.stringify(previous, null, 2)}\n`)

    expect((await supportCli(['update', ...cliOptions(sessions, support)])).code).toBe(0)
    const matrix = await readSupportMatrix(matrixPath(support))

    for (const { key, failed, gap } of variants) {
      expect(supportRowOf(matrix, key)).toMatchObject({
        status: 'unverified',
        gaps: [supportGaps.userScenariosFail([gap])],
        scenarios: { [failed]: 'failed' },
      })
    }
  }, 180_000)

  test('Desktop rows on Windows are listed as not verified, whatever was claimed for them', async () => {
    const { sessions, support } = await workspace()
    await placeRecording(recorded(claudeSubagents), sessions, { os: 'macos' })
    await placeRecording(recorded(claudeSubagents), sessions, { os: 'macos', surface: 'claude_desktop', appVersion: '1.3.9' })
    await mkdir(support, { recursive: true })
    await writeFile(matrixPath(support), `${JSON.stringify({ format: supportMatrixFormat, rows: [claimed(desktopOnWindows, 'full')] }, null, 2)}\n`)

    expect((await supportCli(['update', ...cliOptions(sessions, support)])).code).toBe(0)
    const matrix = await readSupportMatrix(matrixPath(support))

    expect(supportRowOf(matrix, desktopOnWindows)).toMatchObject({
      status: 'unverified',
      gaps: [supportGaps.desktopOnWindows, supportGaps.noRecordings],
    })
    expect(supportRowOf(matrix, { ...desktopOnWindows, os: 'macos' })).toMatchObject({
      status: 'unverified',
      app_version: '1.3.9',
      scenarios: { child_sessions: 'passed' },
    })
    expect(matrix.rows.map(({ surface, os }) => `${surface}/${os}`)).toEqual([
      'claude_cli/macos',
      'claude_desktop/macos',
      'claude_desktop/windows',
    ])
  }, 120_000)
})
