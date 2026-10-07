import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type SupportKey, supportKeyText, supportMatrixFormat, type SupportRow, supportRowOf } from '@aang/contract'
import { readSupportMatrix } from '@aang/contract/support-file'
import { describe, expect, onTestFinished, test } from 'vitest'
import { matrixPath, supportGaps, verificationFormat, verificationPath } from '../dist/index.js'
import { cliOptions, ownerChecklist, placementCheck, supportCli, temporaryDirectory, writeVerification } from './fixtures.js'

const workspace = async (): Promise<{ readonly root: string; readonly sessions: string; readonly support: string }> => {
  const root = await temporaryDirectory((cleanup) => {
    onTestFinished(cleanup)
  }, 'aang-support-verification-')
  await mkdir(join(root, 'sessions'))
  return { root, sessions: join(root, 'sessions'), support: join(root, 'support') }
}

const claudeDesktop: SupportKey = { runtime: 'claude', surface: 'claude_desktop', os: 'macos', placement: 'local', engine_version: '2.1.286' }

const codexDesktop: SupportKey = { runtime: 'codex', surface: 'codex_desktop', os: 'macos', placement: 'local', engine_version: '0.159.2' }

const claudeCli: SupportKey = { runtime: 'claude', surface: 'claude_cli', os: 'linux', placement: 'local', engine_version: '2.1.289' }

const codexExec: SupportKey = { runtime: 'codex', surface: 'codex_exec', os: 'linux', placement: 'local', engine_version: '0.160.0' }

const listedRow = (key: SupportKey): SupportRow => ({
  ...key,
  app_version: null,
  status: 'unverified',
  gaps: [],
  scenarios: {
    during_work: 'not_run',
    after_iteration: 'not_run',
    resume: 'not_run',
    compaction: 'not_run',
    child_sessions: 'not_run',
    reconnect: 'not_run',
  },
  observer: { admission: 'not_run', cross_session_inbound: 'not_run', builtins: { mcp_servers: [], plugins: [], skills: [] } },
  verified_on: null,
})

const writeMatrix = async (support: string, keys: readonly SupportKey[]): Promise<void> => {
  await mkdir(support, { recursive: true })
  await writeFile(matrixPath(support), `${JSON.stringify({ format: supportMatrixFormat, rows: keys.map(listedRow) }, null, 2)}\n`)
}

const notChecked = [supportGaps.noRecordings, supportGaps.userScenarios]

describe('owner checklists in the support matrix', () => {
  test('a passed owner checklist removes the Desktop or TUI gap of its exact key only, a failed one names the failure, and Desktop on Windows needs none', async () => {
    const { sessions, support } = await workspace()
    const cliDocker: SupportKey = { ...claudeCli, placement: 'docker' }
    const cliNewer: SupportKey = { ...claudeCli, engine_version: '2.1.290' }
    const cliWindows: SupportKey = { ...claudeCli, os: 'windows' }
    const desktopLinux: SupportKey = { ...claudeDesktop, os: 'linux' }
    const desktopWindows: SupportKey = { ...claudeDesktop, os: 'windows' }
    await writeMatrix(support, [cliDocker, cliNewer, desktopLinux, desktopWindows, codexExec])
    await writeVerification(support, {
      ownerChecklists: [
        ownerChecklist(claudeDesktop, 'desktop', 'passed'),
        ownerChecklist(codexDesktop, 'desktop', 'failed'),
        ownerChecklist(claudeCli, 'tui', 'passed'),
        ownerChecklist(cliWindows, 'tui', 'failed'),
      ],
    })

    const update = await supportCli(['update', ...cliOptions(sessions, support)])

    expect(update).toMatchObject({ code: 0, stderr: '' })
    const matrix = await readSupportMatrix(matrixPath(support))
    const expected: readonly (readonly [SupportKey, readonly string[]])[] = [
      [claudeDesktop, notChecked],
      [desktopLinux, [...notChecked, supportGaps.desktopChecklist]],
      [desktopWindows, [supportGaps.desktopOnWindows, ...notChecked]],
      [codexDesktop, [...notChecked, supportGaps.desktopChecklistFails]],
      [claudeCli, notChecked],
      [cliDocker, [supportGaps.placement, ...notChecked, supportGaps.tuiChecklist]],
      [cliNewer, [...notChecked, supportGaps.tuiChecklist]],
      [cliWindows, [...notChecked, supportGaps.tuiChecklistFails]],
      [codexExec, notChecked],
    ]
    expect(matrix.rows.map(supportKeyText).sort()).toEqual(expected.map(([key]) => supportKeyText(key)).sort())
    for (const [key, gaps] of expected) {
      expect(supportRowOf(matrix, key), supportKeyText(key)).toMatchObject({ status: 'unverified', gaps })
    }
    expect(await supportCli(['check', ...cliOptions(sessions, support)])).toEqual({ code: 0, stdout: '0 recordings, 0 problems\n', stderr: '' })
  }, 60_000)
})

const report = (finishedAt: string, access: string, results: readonly Readonly<Record<string, unknown>>[]) => ({
  format: 'aang-surface-check/1',
  finished_at: finishedAt,
  image: 'aang-surface-check:2.1.289-0.160.0',
  access: { result: access, detail: 'OAuth on Linux' },
  results,
})

const result = (key: SupportKey | null, verdict: string, emulated = false) => ({
  key,
  emulated,
  result: verdict,
  scenarios: [{ name: 'tools', result: verdict }],
})

describe('placement checks imported from surface check reports', () => {
  test('a report adds a passed or failed entry per non-local result, skips local, emulated and keyless results, and replaces the entry of the same key', async () => {
    const { root, sessions, support } = await workspace()
    const cliDocker: SupportKey = { ...claudeCli, placement: 'docker' }
    const execVm: SupportKey = { ...codexExec, placement: 'vm' }
    const sdkDocker: SupportKey = { ...codexExec, surface: 'codex_sdk', placement: 'docker' }
    const claudeSdkVm: SupportKey = { ...claudeCli, surface: 'claude_sdk', os: 'macos', placement: 'vm' }
    await writeVerification(support, {
      placements: [placementCheck(cliDocker, 'failed', '2026-10-01'), placementCheck(claudeSdkVm, 'passed', '2026-10-02')],
      ownerChecklists: [ownerChecklist(claudeCli, 'tui', 'passed')],
    })
    const linux = join(root, 'surface-check-linux.json')
    const offset = join(root, 'surface-check-offset.json')
    await writeFile(
      linux,
      JSON.stringify(
        report('2026-10-07T12:00:00.000Z', 'passed', [
          result(cliDocker, 'passed'),
          result(execVm, 'failed'),
          result(claudeCli, 'passed'),
          result({ ...codexExec, placement: 'docker' }, 'passed', true),
          result(null, 'failed'),
        ]),
      ),
    )
    await writeFile(offset, JSON.stringify(report('2026-10-08T01:30:00.000+03:00', 'not_run', [result(sdkDocker, 'passed')])))

    const imported = await supportCli(['placement', 'import', linux, offset, '--support', support])

    expect(imported).toEqual({
      code: 0,
      stdout: `placement checks of 2 reports written to ${support}: 1 passed, 2 failed, 3 skipped as local, emulated or without a key\n`,
      stderr: '',
    })
    expect(await readFile(verificationPath(support), 'utf8')).toBe(
      `${JSON.stringify(
        {
          format: verificationFormat,
          placements: [
            placementCheck(cliDocker, 'passed', '2026-10-07'),
            placementCheck(claudeSdkVm, 'passed', '2026-10-02'),
            placementCheck(execVm, 'failed', '2026-10-07'),
            placementCheck(sdkDocker, 'failed', '2026-10-07'),
          ],
          owner_checklists: [ownerChecklist(claudeCli, 'tui', 'passed')],
        },
        null,
        2,
      )}\n`,
    )
    await expect(readFile(matrixPath(support), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

    expect(await supportCli(['update', ...cliOptions(sessions, support)])).toMatchObject({ code: 0, stderr: '' })
    const matrix = await readSupportMatrix(matrixPath(support))
    expect(supportRowOf(matrix, cliDocker)?.gaps).toEqual([...notChecked, supportGaps.tuiChecklist])
    expect(supportRowOf(matrix, execVm)?.gaps).toEqual([supportGaps.placementFails, ...notChecked])
    expect(supportRowOf(matrix, sdkDocker)?.gaps).toEqual([supportGaps.placementFails, ...notChecked])
  }, 60_000)

  test('placement needs reports to import, and a report off its schema is refused without writing anything', async () => {
    const { root, support } = await workspace()
    for (const args of [['placement'], ['placement', 'import'], ['placement', 'check', 'report.json']]) {
      const usage = await supportCli(args)
      expect(usage).toMatchObject({ code: 2, stdout: '' })
      expect(usage.stderr).toContain('placement import <report.json>')
    }
    const broken = join(root, 'surface-check-broken.json')
    await writeFile(broken, JSON.stringify(report('2026-10-07T12:00:00.000Z', 'passed', [result({ ...claudeCli, placement: 'docker' }, 'skipped')])))

    const refused = await supportCli(['placement', 'import', broken, '--support', support])

    expect(refused).toMatchObject({ code: 1, stdout: '' })
    expect(refused.stderr.startsWith(`${broken}: `)).toBe(true)
    expect(refused.stderr).toContain('results[0].result')
    await expect(readFile(verificationPath(support), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('the verification file', () => {
  test('a verification file with a local placement, a duplicate key, a checklist of another surface or an empty report is refused by check, update and placement import', async () => {
    const { root, sessions, support } = await workspace()
    const cliDocker = placementCheck({ ...claudeCli, placement: 'docker' }, 'passed')
    await mkdir(support)
    await writeFile(
      verificationPath(support),
      JSON.stringify({
        format: verificationFormat,
        placements: [cliDocker, { ...cliDocker, result: 'failed' }, placementCheck(claudeCli, 'passed')],
        owner_checklists: [ownerChecklist(claudeDesktop, 'tui', 'passed'), { ...ownerChecklist(claudeCli, 'tui', 'passed'), report: '' }],
      }),
    )
    const emptyReport = join(root, 'surface-check-empty.json')
    await writeFile(emptyReport, JSON.stringify(report('2026-10-07T12:00:00.000Z', 'passed', [])))

    for (const args of [
      ['check', ...cliOptions(sessions, support)],
      ['update', ...cliOptions(sessions, support)],
      ['placement', 'import', emptyReport, '--support', support],
    ]) {
      const refused = await supportCli(args)
      expect(refused).toMatchObject({ code: 1, stdout: '' })
      expect(refused.stderr.startsWith(`${verificationPath(support)}: `)).toBe(true)
      expect(refused.stderr).toContain(`duplicate support key ${supportKeyText(cliDocker)} in placements`)
      expect(refused.stderr).toContain('a placement check needs a placement other than local')
      expect(refused.stderr).toContain('the tui checklist belongs to claude_cli, not to claude_desktop')
      expect(refused.stderr).toContain('owner_checklists[1].report')
    }
    await expect(readFile(matrixPath(support), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

    await writeFile(verificationPath(support), '{"format": ')
    const invalidJson = await supportCli(['check', ...cliOptions(sessions, support)])
    expect(invalidJson.code).toBe(1)
    expect(invalidJson.stderr.startsWith(`${verificationPath(support)}: invalid JSON`)).toBe(true)
  })
})
