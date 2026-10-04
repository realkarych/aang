import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  type ObserverIsolationResult,
  type SupportKey,
  type SupportMatrix,
  supportMatrixFormat,
  type SupportRow,
  supportRowOf,
} from '@aang/contract'
import { readSupportMatrix } from '@aang/contract/support-file'
import { type CodexScenario, installFakeCodex } from '@aang/testkit'
import { describe, expect, onTestFinished, test } from 'vitest'
import { matrixOf, matrixPath, readMatrix, serializeMatrix, supportGaps } from '../dist/index.js'
import { hookBinary, hostOs, otherOs, supportCli, temporaryDirectory, thirdOs } from './fixtures.js'

const version = '0.160.0'

const codexKey = (os: SupportKey['os']): SupportKey => ({ runtime: 'codex', surface: 'codex_exec', os, placement: 'local', engine_version: version })

const noBuiltins = { mcp_servers: [], plugins: [], skills: [] }

const admission = (result: ObserverIsolationResult['admission']): ObserverIsolationResult => ({
  admission: result,
  cross_session_inbound: 'not_run',
  builtins: noBuiltins,
})

const notRun = admission('not_run')

const rowWithoutRecordings = (key: SupportKey, observer: ObserverIsolationResult): SupportRow => ({
  ...key,
  app_version: null,
  status: 'unverified',
  gaps: [supportGaps.noRecordings, supportGaps.userScenarios],
  scenarios: {
    during_work: 'not_run',
    after_iteration: 'not_run',
    resume: 'not_run',
    compaction: 'not_run',
    child_sessions: 'not_run',
    reconnect: 'not_run',
  },
  observer,
  verified_on: null,
})

const claudeRow = rowWithoutRecordings(
  { runtime: 'claude', surface: 'claude_cli', os: hostOs, placement: 'local', engine_version: '2.1.289' },
  {
    admission: 'passed',
    cross_session_inbound: 'passed',
    builtins: { mcp_servers: [], plugins: [{ name: 'cc-plugin-agents-md', source: 'cc-plugin-agents-md@builtin', path: 'builtin' }], skills: [] },
  },
)

const matrixOfRows = (rows: readonly SupportRow[]): SupportMatrix => ({ format: supportMatrixFormat, rows: [...rows] })

const directory = (prefix: string): Promise<string> =>
  temporaryDirectory((cleanup) => {
    onTestFinished(cleanup)
  }, prefix)

const supportWith = async (rows: readonly SupportRow[]): Promise<string> => {
  const support = await directory('aang-isolation-support-')
  await writeFile(matrixPath(support), serializeMatrix(matrixOfRows(rows)))
  return support
}

const fakeCodex = async (scenario: CodexScenario) => {
  const root = await directory('aang-isolation-codex-')
  const fake = installFakeCodex(root, scenario)
  if (process.platform !== 'win32') {
    return { fake, cli: fake.command }
  }
  const bin = join(root, 'npm')
  const scripts = join(bin, 'node_modules', '@openai', 'codex', 'bin')
  const [script = '', state = ''] = fake.args
  await mkdir(scripts, { recursive: true })
  await writeFile(join(bin, 'codex.cmd'), 'exit /b 99')
  await writeFile(
    join(scripts, 'codex.js'),
    `process.argv.splice(1, 1, ${JSON.stringify(script)}, ${JSON.stringify(state)}); await import(${JSON.stringify(pathToFileURL(script).href)});`,
  )
  return { fake, cli: join(bin, 'codex.cmd') }
}

const isolation = (support: string, cli: string) => supportCli(['isolation', 'codex', '--support', support, '--hook', hookBinary, '--cli', cli])

const keyText = (key: SupportKey): string => JSON.stringify([key.runtime, key.surface, key.os, key.placement, key.engine_version])

describe('observer isolation of the installed Codex CLI in the support matrix', () => {
  test('a passed admission goes into the row of this OS and CLI version, and the contract run keeps it', async () => {
    const support = await supportWith([claudeRow])
    const { fake, cli } = await fakeCodex({ version })

    const result = await isolation(support, cli)

    expect(result).toMatchObject({ code: 0, stdout: `${keyText(codexKey(hostOs))}: admission passed\n` })
    const written = await readFile(matrixPath(support), 'utf8')
    expect(JSON.parse(written)).toEqual(matrixOfRows([claudeRow, rowWithoutRecordings(codexKey(hostOs), admission('passed'))]))
    expect(matrixOf([], await readMatrix(support))).toBe(written)
    const probes = fake.calls().filter((call) => call.command === 'exec')
    expect(probes).toHaveLength(2)
    expect(probes.every((call) => call.argv.includes('--dangerously-bypass-hook-trust'))).toBe(true)

    expect(await isolation(support, cli)).toMatchObject({ code: 0 })
    expect(await readFile(matrixPath(support), 'utf8')).toBe(written)
  }, 120_000)

  test('a CLI that runs hooks with hooks disabled turns the recorded admission into failed', async () => {
    const support = await supportWith([rowWithoutRecordings(codexKey(hostOs), admission('passed'))])
    const { cli } = await fakeCodex({ version, admissionFault: 'hook_leak' })

    const result = await isolation(support, cli)

    expect(result).toMatchObject({ code: 1, stdout: `${keyText(codexKey(hostOs))}: admission failed (Codex hooks executed with hooks disabled)\n` })
    expect(await readMatrix(support)).toEqual(matrixOfRows([rowWithoutRecordings(codexKey(hostOs), admission('failed'))]))
  }, 120_000)

  test('a check that does not reach a verdict leaves the matrix as it was', async () => {
    const support = await supportWith([claudeRow, rowWithoutRecordings(codexKey(hostOs), admission('passed'))])
    const before = await readFile(matrixPath(support), 'utf8')

    const missing = await isolation(support, join(support, 'missing', 'codex'))
    const withoutOutput = await isolation(support, (await fakeCodex({ version, admissionFault: 'missing_last' })).cli)
    const offSchema = await isolation(support, (await fakeCodex({ version, admissionFault: 'off_schema_last' })).cli)

    expect(missing).toMatchObject({ code: 1, stdout: '' })
    expect(missing.stderr).toMatch(/^the Codex admission did not complete: .*CLI not found/)
    expect(withoutOutput).toMatchObject({ code: 1, stdout: '' })
    expect(withoutOutput.stderr).toMatch(/^the Codex admission did not complete: /)
    expect(offSchema).toMatchObject({ code: 1, stdout: '' })
    expect(offSchema.stderr).toMatch(/^the Codex admission did not complete: Codex admission output was invalid/)
    expect(await readFile(matrixPath(support), 'utf8')).toBe(before)
  }, 120_000)

  test('results written on other runners are imported into the rows of their OS', async () => {
    const support = await supportWith([claudeRow, rowWithoutRecordings(codexKey(hostOs), admission('passed'))])
    const runners = await directory('aang-isolation-runners-')
    const other = join(runners, otherOs, 'matrix.json')
    const third = join(runners, thirdOs, 'matrix.json')
    await mkdir(join(runners, otherOs))
    await mkdir(join(runners, thirdOs))
    await writeFile(other, serializeMatrix(matrixOfRows([rowWithoutRecordings(codexKey(otherOs), admission('passed'))])))
    await writeFile(third, serializeMatrix(matrixOfRows([rowWithoutRecordings(codexKey(thirdOs), admission('failed')), rowWithoutRecordings(codexKey(hostOs), notRun)])))

    const result = await supportCli(['isolation', 'import', other, third, '--support', support])

    expect(result).toMatchObject({ code: 0, stdout: `observer isolation of 2 matrices written to ${support}\n` })
    const imported = await readMatrix(support)
    expect(imported === null ? null : supportRowOf(imported, codexKey(otherOs))?.observer).toEqual(admission('passed'))
    expect(imported === null ? null : supportRowOf(imported, codexKey(thirdOs))?.observer).toEqual(admission('failed'))
    expect(imported === null ? null : supportRowOf(imported, codexKey(hostOs))?.observer).toEqual(admission('passed'))
    expect(imported?.rows).toHaveLength(4)
    expect(matrixOf([], imported)).toBe(await readFile(matrixPath(support), 'utf8'))
  })

  test('isolation needs a runtime or matrices to import', async () => {
    for (const args of [['isolation'], ['isolation', 'claude'], ['isolation', 'import'], ['isolation', 'codex', 'extra']]) {
      const result = await supportCli(args)
      expect(result).toMatchObject({ code: 2, stdout: '' })
      expect(result.stderr).toContain('isolation codex')
    }
  })
})

const installedCodex = process.env['AANG_ISOLATION_CODEX']

test.skipIf(installedCodex === undefined)(
  'the installed Codex CLI keeps the observer profile isolated, and support/matrix.json records the result of this OS',
  async () => {
    const support = await directory('aang-isolation-contract-')
    const result = await isolation(support, installedCodex ?? 'codex')

    expect(result.code, result.stdout + result.stderr).toBe(0)
    const [row] = (await readSupportMatrix(matrixPath(support))).rows
    const recorded = row === undefined ? null : supportRowOf(await readSupportMatrix(resolve('support', 'matrix.json')), row)
    expect(recorded?.observer, `support/matrix.json does not record ${result.stdout.trim()}`).toEqual(row?.observer)
  },
  300_000,
)
