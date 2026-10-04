import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { endpoints } from '@aang/contract'
import { objectId, runId } from '@aang/contract/ids'
import { afterAll, beforeAll, describe, test } from 'vitest'
import { docker, dockerOk } from './docker.js'
import { aangHome, aangPaths, startSolver } from './solver.js'

const repository = fileURLToPath(new URL('../../../', import.meta.url))
const sessionStartSample = new URL('../../../docs/research/samples/claude-code-hooks/SessionStart.startup.json', import.meta.url)
const fakeSolver = '/opt/fake-solver/dist/main.js'
const subagentSample = '/opt/samples/packages/testkit/sample-scenarios/claude-subagent/manifest.json'
const subagentSession = { kind: 'session', runtime: 'claude', session: '86f93ed5-1acd-4c6e-8c60-f1c98335c2ef' } as const
const buildTimeoutMs = 1_200_000
const testTimeoutMs = 120_000
const ingestTimeoutMs = 30_000

const tag = randomUUID()
const images = {
  aang: `aang-smoke:${tag}`,
  build: `aang-smoke-build:${tag}`,
  solver: `aang-smoke-solver:${tag}`,
}

const build = (image: string, args: readonly string[]): Promise<string> =>
  dockerOk(['build', '--progress=plain', '--tag', image, ...args, repository])

describe('the aang Docker image as the base of a solver image', { tags: ['docker'] }, () => {
  beforeAll(async () => {
    await build(images.aang, [])
    await build(images.build, ['--target', 'build'])
    await build(images.solver, [
      '--file',
      fileURLToPath(new URL('../solver.Dockerfile', import.meta.url)),
      '--build-arg',
      `AANG_IMAGE=${images.aang}`,
      '--build-arg',
      `BUILD_IMAGE=${images.build}`,
    ])
  }, buildTimeoutMs)

  afterAll(async () => {
    await docker(['image', 'rm', '--force', ...Object.values(images)])
  })

  test('the image runs aang and aang-hook on Node 26 as the user node', { timeout: testTimeoutMs }, async ({ expect }) => {
    const run = (args: readonly string[]) => docker(['run', '--rm', images.aang, ...args])

    expect(await run(['whoami'])).toEqual({ code: 0, stdout: 'node\n', stderr: '' })
    expect(await docker(['run', '--rm', '--init', images.aang, 'whoami'])).toEqual({ code: 0, stdout: 'node\n', stderr: '' })
    expect((await run(['node', '--version'])).stdout).toMatch(/^v26\./)
    const status = await run(['aang', 'status'])
    expect(status).toMatchObject({ code: 0, stderr: '' })
    expect(status.stdout).toContain(`aang home: ${aangHome}\ndaemon: not running\nspool: 0 files`)
    const hook = await run(['aang-hook', 'claude', 'plugin', aangPaths.spool])
    expect(hook).toEqual({ code: 0, stdout: '', stderr: '' })
  })

  test('in a derived image with fake CLIs the player writes a sample and the API behind the UI token returns its run', { timeout: testTimeoutMs }, async ({
    expect,
    onTestFinished,
  }) => {
    const solver = await startSolver(images.solver, onTestFinished)
    expect((await solver.exec(['claude', '--version'])).stdout).toMatch(/\(Claude Code\)\n$/)
    expect((await solver.exec(['codex', '--version'])).stdout).toMatch(/^codex-cli /)
    expect((await fetch(new URL(endpoints.runs.path, solver.origin))).status).toBe(401)
    const user = await solver.signIn()
    expect(await user.runs()).toEqual([])

    const played = await solver.exec(['node', fakeSolver, 'play', subagentSample])

    expect(played).toEqual({ code: 0, stdout: '', stderr: '' })
    await expect
      .poll(async () => (await user.runs()).map(({ id, agents }) => ({ id, agents })), { timeout: ingestTimeoutMs })
      .toEqual([{ id: runId(subagentSession), agents: 2 }])
    expect(await user.runs()).toMatchObject([
      { runtime: 'claude', root_session: objectId(subagentSession), sessions: 1, support_modes: ['files_only'] },
    ])
    expect(await solver.exec(['aang', 'stop'])).toEqual({
      code: 0,
      stdout: `aang stopped: pid ${String(solver.pid)}\n`,
      stderr: '',
    })
  })

  test('aang-hook of the image hands a session start to the daemon, which lists a hooks-only run', { timeout: testTimeoutMs }, async ({
    expect,
    onTestFinished,
  }) => {
    const solver = await startSolver(images.solver, onTestFinished)
    const user = await solver.signIn()
    const session = { kind: 'session', runtime: 'claude', session: randomUUID() } as const
    const sample = JSON.parse(await readFile(sessionStartSample, 'utf8')) as Record<string, unknown>
    const payload = JSON.stringify({ ...sample, session_id: session.session, cwd: '/home/node/work' })

    const hooked = await solver.exec(['aang-hook', 'claude', 'plugin', aangPaths.spool], { input: payload })

    expect(hooked).toEqual({ code: 0, stdout: '', stderr: '' })
    await expect
      .poll(async () => (await user.runs()).map(({ id, support_modes }) => ({ id, support_modes })), {
        timeout: ingestTimeoutMs,
      })
      .toEqual([{ id: runId(session), support_modes: ['hooks_only'] }])
  })
})
