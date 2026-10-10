import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { tasks } from './tasks.mjs'

const repository = fileURLToPath(new URL('../../../../', import.meta.url))
const { readRollout, rolloutFiles, threadOf } = await import(join(repository, 'tools/record/dist/codex/rollout.js'))
const task = process.env.AANG_Q2_TASK ?? 'ledger'
const engine = process.env.AANG_Q2_CODEX ?? '/opt/homebrew/bin/codex'
const fixturesRoot = resolve(process.env.AANG_Q2_FIXTURES ?? join(repository, 'fixtures/sessions'))
const pausesMs = [45_000, 30_000, 60_000, 40_000, 35_000, 50_000, 20_000, 45_000, 30_000, 55_000, 40_000, 35_000]
const budgetMs = Number(process.env.AANG_Q2_BUDGET_MS ?? 120 * 60_000)
const version = /^codex-cli (\S+)$/.exec(execFileSync(engine, ['--version'], { encoding: 'utf8' }).trim())?.[1]
if (version === undefined) throw new Error('The Codex CLI did not report its version')
const definition = tasks[task]
if (definition === undefined) throw new Error(`Unknown task ${task}`)

export const options = {
  runtime: 'codex',
  engineVersion: version,
  surface: 'codex_exec',
  scenario: `workload-${task}`,
  model: 'live',
  codexHome: 'regular',
  expectedFacts: [
    `A live codex exec session in the regular CODEX_HOME without hooks works through the ${task} task of SPEC.md, each turn a codex exec resume of the same thread`,
    'The session plans with update_plan, implements and tests stages, spawns subagents, is compacted once by a low auto-compaction limit, changes its plan and commits with git; plugins of the regular home are disabled',
    'Decisions that a Claude session asks the user about are given in the prompt, because codex exec cannot ask',
  ],
  fixturesRoot,
  hookBinary: join(repository, 'packages/hook/bin/aang-hook'),
}

const flags = ['--json', '--skip-git-repo-check', '--ignore-user-config', '--disable', 'hooks', '--disable', 'plugins', '--sandbox', 'workspace-write', '-c', 'tools.update_plan.enabled=true']
const compaction = ['-c', 'model_auto_compact_token_limit_scope="total"', '-c', 'model_auto_compact_token_limit=10000']
const git = (project, ...args) => execFileSync('git', args, { cwd: project, stdio: 'ignore' })

const decisions = {
  rounding: 'Use half-up rounding for converted amounts: the user chose it.',
  format: 'The user chose a single self-contained HTML file for the report.',
  durability: 'The user chose durable compaction: call fsync on the snapshot and on the directory.',
  slugs: 'The user chose case-sensitive matching of anchors.',
}

const adapted = ({ name, prompt }) => {
  if (prompt === '/compact') return 'Summarize the state of the work in three sentences without running any command.'
  const decided = prompt.replace(/(?:Before [^,]+, )?ask me with the AskUserQuestion tool [^.]*\.(?: Then)?/, `${decisions[name] ?? ''} Then`)
  return decided
    .replace(/Use the Agent tool to start one general-purpose subagent that/g, 'Spawn one subagent that')
    .replace(/In a single message start two general-purpose subagents with the Agent tool in parallel:/g, 'Spawn two subagents that work in parallel:')
    .replace(/Track the stages with your task list tool\./g, 'Track the stages with your plan tool.')
}

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

const rolloutOf = async (codexHome, thread) => {
  const path = (await rolloutFiles(codexHome)).find((file) => file.endsWith(`-${thread}.jsonl`))
  if (path === undefined) throw new Error(`No rollout of thread ${thread}`)
  return readRollout(codexHome, path)
}

const itemOf = (line) => (line.type === 'event_msg' && line.payload?.type === 'item_completed' ? line.payload.item : undefined)
const commandText = (item) => (Array.isArray(item?.command) ? item.command.join(' ') : String(item?.command ?? ''))
const commandItem = (pattern) => (line) => itemOf(line)?.type === 'CommandExecution' && pattern.test(commandText(itemOf(line)))

const selectors = {
  test: () => commandItem(/node --test|npm (run )?test/),
  command: (event) => commandItem(new RegExp(event.text.replaceAll(' ', '\\s+'))),
  write: (event) => (line) => itemOf(line)?.type === 'FileChange' && Object.keys(itemOf(line).changes ?? {}).some((path) => event.path.test(path)),
  agent: () => (line) => itemOf(line)?.type === 'CollabAgentToolCall' && itemOf(line).tool === 'wait',
}

const mark = async (session, event, rollout, after, skipped) => {
  const select = selectors[event.kind]?.(event)
  const line = select === undefined ? undefined : rollout.lines.findLast((candidate) => candidate.ordinal > after && select(candidate))
  const targets = [
    ...(line === undefined ? [] : [{ ...rollout.target, contains: `"ordinal":${String(line.ordinal)},`, occurrence: 'last' }]),
    ...(select === undefined ? [{ ...rollout.target, contains: '"type":"task_complete"', occurrence: 'last' }] : []),
  ]
  for (const target of targets) {
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
  let thread
  let after = -1
  for (const [index, turn] of definition.turns.entries()) {
    if (Date.now() - started > budgetMs) break
    if (index > 0) await sleep(pausesMs[index % pausesMs.length])
    const prompt = adapted(turn)
    const args = thread === undefined
      ? ['exec', ...flags, prompt]
      : ['exec', ...flags, ...(turn.prompt === '/compact' ? compaction : []), 'resume', thread, prompt]
    const { stdout } = await session.run(engine, args, { timeoutMs: 45 * 60_000 })
    const turnThread = threadOf(stdout)
    if (thread !== undefined && turnThread !== thread) throw new Error(`Turn ${turn.name} left thread ${thread} for ${turnThread}`)
    thread = turnThread
    const rollout = await rolloutOf(session.codex, thread)
    for (const event of turn.events.filter(({ kind }) => kind !== 'question')) await mark(session, event, rollout, after, skipped)
    after = Math.max(after, ...rollout.lines.map(({ ordinal }) => ordinal ?? -1))
    process.stderr.write(`turn ${turn.name} done after ${String(Math.round((Date.now() - started) / 1000))} s; rollout lines ${String(rollout.lines.length)}\n`)
  }
  if (skipped.length > 0) process.stderr.write(`events without a captured target: ${skipped.join(', ')}\n`)
}
