import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { endpoints } from '@aang/contract'
import { objectId, runId } from '@aang/contract/ids'
import { afterAll, beforeAll, describe, test } from 'vitest'
import { docker, dockerOk } from './docker.js'
import { aangHome, aangPaths, type Solver, startSolver } from './solver.js'

const repository = fileURLToPath(new URL('../../../', import.meta.url))
const claudeHookSamples = new URL('../../../docs/research/samples/claude-code-hooks/', import.meta.url)
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

const work = { repository: '/home/node/work/repository', linked: '/home/node/work/linked', elsewhere: '/home/node/elsewhere' }
const createRepository = [
  'git init --quiet "$1"',
  'git -C "$1" -c user.name=aang -c user.email=aang@localhost commit --quiet --allow-empty --message init',
  'git -C "$1" worktree add --quiet "$2"',
  'mkdir "$3"',
].join('\n')

const build = (image: string, args: readonly string[]): Promise<string> =>
  dockerOk(['build', '--progress=plain', '--tag', image, ...args, repository])

const claudeHook = async (sample: string, session: string, cwd: string): Promise<string> => {
  const payload = JSON.parse(await readFile(new URL(sample, claudeHookSamples), 'utf8')) as Record<string, unknown>
  return JSON.stringify({ ...payload, session_id: session, cwd })
}

const claudeSession = () => ({ kind: 'session', runtime: 'claude', session: randomUUID() }) as const

const deliver = (solver: Solver, payload: string) => solver.exec(['aang-hook', 'claude', 'plugin', aangPaths.spool], { input: payload })

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

  test('aang install in a derived image connects the Claude plugin and the Codex hooks with the aang-hook of the image', { timeout: testTimeoutMs }, async ({
    expect,
    onTestFinished,
  }) => {
    const solver = await startSolver(images.solver, onTestFinished)

    const installed = await solver.exec(['aang', 'install'])

    expect(installed).toMatchObject({ code: 0, stderr: '' })
    expect(installed.stdout).toContain(`claude: plugin aang@aang installed from ${aangHome}/claude-plugin`)
    expect(installed.stdout).toContain('codex: aang hooks registered in /home/node/.codex/hooks.json')
    expect(await solver.exec(['cmp', '/usr/local/bin/aang-hook', `${aangHome}/bin/aang-hook`])).toEqual({ code: 0, stdout: '', stderr: '' })
    const command = `'${aangHome}/bin/aang-hook' 'codex' 'user' '${aangPaths.spool}'`
    expect((await solver.exec(['cat', '/home/node/.codex/hooks.json'])).stdout).toContain(JSON.stringify(command).slice(1, -1))
    const session = claudeSession()
    const hooked = await solver.exec(['sh', '-c', 'exec "$1/bin/aang-hook" claude plugin "$2"', 'sh', aangHome, aangPaths.spool], {
      input: await claudeHook('SessionStart.startup.json', session.session, '/home/node/work'),
    })
    expect(hooked).toEqual({ code: 0, stdout: '', stderr: '' })
    const user = await solver.signIn()
    await expect
      .poll(async () => (await user.runs()).map(({ id }) => id), { timeout: ingestTimeoutMs })
      .toEqual([runId(session)])
  })

  test('aang-hook of the image hands a session start to the daemon, which lists a hooks-only run', { timeout: testTimeoutMs }, async ({
    expect,
    onTestFinished,
  }) => {
    const solver = await startSolver(images.solver, onTestFinished)
    const user = await solver.signIn()
    const session = claudeSession()

    const hooked = await deliver(solver, await claudeHook('SessionStart.startup.json', session.session, '/home/node/work'))

    expect(hooked).toEqual({ code: 0, stdout: '', stderr: '' })
    await expect
      .poll(async () => (await user.runs()).map(({ id, support_modes }) => ({ id, support_modes })), {
        timeout: ingestTimeoutMs,
      })
      .toEqual([{ id: runId(session), support_modes: ['hooks_only'] }])
  })

  test('git of the image admits a session in a linked worktree of a watched repository outside its directory', { timeout: testTimeoutMs }, async ({
    expect,
    onTestFinished,
  }) => {
    const solver = await startSolver(images.solver, onTestFinished, {
      watch: { all: false, roots: [{ path: work.repository }] },
      prepare: ['sh', '-ec', createRepository, 'sh', work.repository, work.linked, work.elsewhere],
    })
    const user = await solver.signIn()
    const external = claudeSession()
    const linked = claudeSession()

    for (const [session, cwd] of [
      [external, work.elsewhere],
      [linked, work.linked],
    ] as const) {
      const hooked = await deliver(solver, await claudeHook('SessionStart.startup.json', session.session, cwd))
      expect(hooked).toEqual({ code: 0, stdout: '', stderr: '' })
    }

    await expect
      .poll(async () => (await user.runs()).map(({ id }) => id), { timeout: ingestTimeoutMs })
      .toEqual([runId(linked)])
  })
})
