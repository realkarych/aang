import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type SupportKey,
  SupportMatrix,
  supportMatrixFormat,
  type SupportRow,
  supportRowOf,
  supportStatusOf,
} from '@aang/contract'
import { readSupportMatrix, SupportMatrixError } from '@aang/contract/support-file'
import { describe, test, type TestContext } from 'vitest'
import { z } from 'zod'

const ClaudeInit = z.object({
  claude_code_version: z.string(),
  mcp_servers: z.array(z.object({ name: z.string(), source: z.string() })),
  plugins: z.array(z.object({ name: z.string(), source: z.string(), path: z.string() })),
  skills: z.array(z.string()),
})

const observerProfileInit = new URL(
  '../../../docs/research/samples/observer/claude-init-b-full-isolation.json',
  import.meta.url,
)

describe.concurrent('support matrix', () => {
  test('a row keeps the builtins the observer profile reports in system/init', async ({ expect }) => {
    const init = ClaudeInit.parse(JSON.parse(await readFile(observerProfileInit, 'utf8')))
    const row: SupportRow = {
      runtime: 'claude',
      surface: 'claude_cli',
      os: 'macos',
      placement: 'local',
      engine_version: init.claude_code_version,
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
      observer: {
        admission: 'passed',
        cross_session_inbound: 'passed',
        builtins: {
          mcp_servers: init.mcp_servers,
          plugins: init.plugins.filter((plugin) => plugin.path === 'builtin'),
          skills: init.skills,
        },
      },
      verified_on: '2026-10-01',
    }
    const matrix = { format: supportMatrixFormat, rows: [row] }

    const restored = SupportMatrix.parse(JSON.parse(JSON.stringify(matrix)))

    expect(restored).toEqual(matrix)
    expect(restored.rows[0]?.observer.builtins.plugins.map((plugin) => plugin.source)).toEqual([
      'cc-plugin-agents-md@builtin',
      'cc-plugin-plugin-authoring@builtin',
    ])
  })
})

const key: SupportKey = {
  runtime: 'codex',
  surface: 'codex_exec',
  os: 'linux',
  placement: 'local',
  engine_version: '0.160.0',
}

const limitedRow: SupportRow = {
  ...key,
  app_version: null,
  status: 'limited',
  gaps: ['compaction'],
  scenarios: {
    during_work: 'passed',
    after_iteration: 'passed',
    resume: 'passed',
    compaction: 'failed',
    child_sessions: 'passed',
    reconnect: 'passed',
  },
  observer: { admission: 'passed', cross_session_inbound: 'not_run', builtins: { mcp_servers: [], plugins: [], skills: [] } },
  verified_on: '2026-10-04',
}

const matrixDirectory = async ({ onTestFinished }: TestContext): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'aang-support-matrix-'))
  onTestFinished(() => rm(directory, { recursive: true, force: true }))
  return directory
}

describe.concurrent('reading the support matrix', () => {
  test('a listed key reads its row; a version, OS or placement outside the matrix is unverified', async (context) => {
    const { expect } = context
    const directory = await matrixDirectory(context)
    const path = join(directory, 'matrix.json')
    await writeFile(path, `${JSON.stringify({ format: supportMatrixFormat, rows: [limitedRow] }, null, 2)}\n`)

    const matrix = await readSupportMatrix(path)

    expect(supportRowOf(matrix, key)).toEqual(limitedRow)
    expect(supportStatusOf(matrix, key)).toBe('limited')
    expect(supportStatusOf(matrix, { ...key, engine_version: '0.160.1' })).toBe('unverified')
    expect(supportStatusOf(matrix, { ...key, os: 'windows' })).toBe('unverified')
    expect(supportStatusOf(matrix, { ...key, placement: 'docker' })).toBe('unverified')
    expect(supportRowOf(matrix, { ...key, surface: 'codex_tui' })).toBeNull()
  })

  test('a matrix file with a repeated key or broken JSON is rejected with its path', async (context) => {
    const { expect } = context
    const directory = await matrixDirectory(context)
    const repeated = join(directory, 'repeated.json')
    const broken = join(directory, 'broken.json')
    await writeFile(repeated, JSON.stringify({ format: supportMatrixFormat, rows: [limitedRow, limitedRow] }))
    await writeFile(broken, '{"format":')

    await expect(readSupportMatrix(repeated)).rejects.toThrow(SupportMatrixError)
    await expect(readSupportMatrix(repeated)).rejects.toThrow(/duplicate support key/)
    const failure: unknown = await readSupportMatrix(broken).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(SupportMatrixError)
    expect(failure).toMatchObject({ path: broken })
    expect((failure as SupportMatrixError).reason).toMatch(/^invalid JSON/)
  })
})
