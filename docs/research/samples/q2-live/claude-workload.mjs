import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { tasks } from './tasks.mjs'

const repository = fileURLToPath(new URL('../../../../', import.meta.url))
const streamHost = join(repository, 'tools/record/dist/claude/stream-host.js')
const task = process.env.AANG_Q2_TASK ?? 'ledger'
const engine = process.env.AANG_Q2_CLAUDE ?? join(process.env.HOME ?? '', '.local/bin/claude')
const fixturesRoot = resolve(process.env.AANG_Q2_FIXTURES ?? join(repository, 'fixtures/sessions'))
const pausesMs = [45_000, 30_000, 60_000, 40_000, 35_000, 50_000, 20_000, 45_000, 30_000, 55_000, 40_000, 35_000]
const budgetMs = Number(process.env.AANG_Q2_BUDGET_MS ?? 90 * 60_000)
const version = /^(\S+) \(Claude Code\)$/.exec(execFileSync(engine, ['--version'], { encoding: 'utf8' }).trim())?.[1]
if (version === undefined) throw new Error('The Claude CLI did not report its version')
const definition = tasks[task]
if (definition === undefined) throw new Error(`Unknown task ${task}`)

export const options = {
  runtime: 'claude',
  engineVersion: version,
  surface: 'claude_cli',
  scenario: `workload-${task}`,
  model: 'live',
  expectedFacts: [
    `A live Claude Code session in claude -p stream-json mode works through the ${task} task of SPEC.md in ${String(definition.turns.length)} turns, each turn a resumed run of the same session`,
    'The host approves permission requests of unlisted commands after 2.5 s and answers AskUserQuestion with the first option after 15 s',
    'The session plans, implements and tests stages, asks one explicit question, runs subagents, is compacted once, changes its plan and commits with git',
  ],
  fixturesRoot,
  hookBinary: join(repository, 'packages/hook/bin/aang-hook'),
  claudeHome: 'regular',
}

const allowed = [
  'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep', 'LS', 'TodoWrite', 'Task', 'Agent', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet',
  'TaskOutput', 'BashOutput', 'KillShell', 'Skill',
  'Bash(node:*)', 'Bash(npm test:*)', 'Bash(npm run:*)', 'Bash(ls:*)', 'Bash(cat:*)', 'Bash(head:*)', 'Bash(tail:*)', 'Bash(wc:*)', 'Bash(mkdir:*)',
  'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)',
]
const pool = (tool, count, delayMs, extra = {}) => Array.from({ length: count }, () => ({ tool, behavior: 'allow', delayMs, optional: true, ...extra }))
const decisions = [
  ...pool('AskUserQuestion', 3, 15_000, { answer: 0 }),
  ...pool('Bash', 300, 2_500),
  ...pool('Write', 50, 1_500),
  ...pool('Edit', 50, 1_500),
  ...pool('MultiEdit', 20, 1_500),
  ...pool('ExitPlanMode', 3, 5_000),
  ...pool('EnterPlanMode', 3, 1_000),
]
const quiet = { DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1' }
const git = (project, ...args) => execFileSync('git', args, { cwd: project, stdio: 'ignore' })

const prepare = async (project) => {
  for (const [path, content] of Object.entries(definition.files)) {
    await mkdir(dirname(join(project, path)), { recursive: true })
    await writeFile(join(project, path), content)
  }
  git(project, 'init', '--quiet', '--initial-branch=main')
  git(project, 'config', 'user.name', 'aang')
  git(project, 'config', 'user.email', 'aang@example.invalid')
  git(project, 'add', '-A')
  git(project, 'commit', '--quiet', '-m', 'Initial specification')
}

const rootUses = (summary) => summary.toolUses.filter(({ parent }) => parent === null)
const inputOf = (use) => (typeof use.input === 'object' && use.input !== null ? use.input : {})
const commandOf = (use) => String(inputOf(use).command ?? '')
const targets = (event, summary, sessionId) => {
  const uses = rootUses(summary)
  const hooks = (picked) => picked.toReversed().map(({ id }) => ({ hook: { event: 'PostToolUse', toolUseId: id } }))
  switch (event.kind) {
    case 'write':
      return hooks(uses.filter((use) => ['Write', 'Edit', 'MultiEdit'].includes(use.name) && event.path.test(String(inputOf(use).file_path ?? ''))))
    case 'test':
      return hooks(uses.filter((use) => use.name === 'Bash' && /node --test|npm (run )?test/.test(commandOf(use))))
    case 'agent':
      return hooks(uses.filter((use) => use.name === 'Agent' || use.name === 'Task'))
    case 'question':
      return hooks(uses.filter((use) => use.name === 'AskUserQuestion'))
    case 'command':
      return hooks(uses.filter((use) => use.name === 'Bash' && commandOf(use).includes(event.text)))
    default:
      return [{ hook: { event: 'Stop', sessionId }, occurrence: 'last' }]
  }
}

const mark = async (session, event, summary, sessionId, skipped) => {
  for (const target of targets(event, summary, sessionId)) {
    try {
      await session.checkpoint(event.label, target, event.description)
      return
    } catch {
      continue
    }
  }
  skipped.push(event.label)
}

export const run = async (session) => {
  await prepare(session.project)
  const started = Date.now()
  const skipped = []
  let sessionId
  for (const [index, { name, prompt, events }] of definition.turns.entries()) {
    if (Date.now() - started > budgetMs) break
    if (index > 0) await sleep(pausesMs[index % pausesMs.length])
    const plan = join(session.work, `${name}.plan.json`)
    const summaryPath = join(session.work, `${name}.summary.json`)
    await writeFile(plan, `${JSON.stringify({
      engine,
      args: ['-p', '--allowedTools', allowed.join(','), '--disallowedTools', 'WebFetch,WebSearch'],
      env: {},
      ...(sessionId === undefined ? {} : { resume: sessionId }),
      turns: [{ prompt }],
      decisions,
      turnTimeoutMs: 30 * 60_000,
    }, null, 2)}\n`)
    await session.run(process.execPath, [streamHost, plan, summaryPath], { env: quiet, timeoutMs: 45 * 60_000 })
    const summary = JSON.parse(await readFile(summaryPath, 'utf8'))
    const turnSession = summary.results.at(-1)?.sessionId
    if (turnSession === undefined) throw new Error(`Turn ${name} reported no result`)
    if (sessionId !== undefined && turnSession !== sessionId) throw new Error(`Turn ${name} left session ${sessionId} for ${turnSession}`)
    sessionId = turnSession
    for (const event of events) await mark(session, event, summary, sessionId, skipped)
    process.stderr.write(`turn ${name} done after ${String(Math.round((Date.now() - started) / 1000))} s; tools ${String(summary.toolUses.length)}, decisions ${String(summary.decisions.length)}\n`)
  }
  if (skipped.length > 0) process.stderr.write(`events without a captured target: ${skipped.join(', ')}\n`)
}
