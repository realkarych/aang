import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { hookRecords, hooksNamed } from '../hooks.js'
import type { RunOutput } from '../record.js'
import type { Scenario, ScenarioSession } from '../scenario.js'
import { checkSubagents, exists, shell, subagentFacts, subagentScript, toolSteps } from './calls.js'
import { hostScript, stubScenario } from './harness.js'
import { check, completedItems, finished, jsonLines, type Json, rolloutOf, sessionMeta } from './rollout.js'
import { logRecords } from './telemetry.js'

const surface = 'codex_desktop'

interface DesktopRun {
  readonly thread: Readonly<Record<string, unknown>>
  readonly prompts: readonly string[]
}

const runDesktop = async (session: ScenarioSession, run: DesktopRun): Promise<RunOutput> => {
  const plan = join(session.work, 'codex-desktop-plan.json')
  await writeFile(plan, `${JSON.stringify({
    codex: session.engine.executable,
    client: { name: 'codex_desktop', title: 'Codex Desktop', version: session.engine.appVersion ?? '0.0.0' },
    thread: { cwd: session.project, ...run.thread },
    turns: run.prompts.map((prompt) => ({ prompt })),
    approval: { decision: 'accept', delayMs: 1_000 },
  })}\n`)
  return session.run(process.execPath, [hostScript('desktop-host'), plan], { env: { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'Codex Desktop', OTEL_BLRP_SCHEDULE_DELAY: '200' } })
}

const messages = (stdout: string, method: string): Json[] => jsonLines(stdout).filter((message) => message['method'] === method)

const rootThread = (stdout: string): string => {
  const params = messages(stdout, 'thread/started')[0]?.['params']
  const thread = typeof params === 'object' && params !== null && 'thread' in params ? params.thread : undefined
  const id = typeof thread === 'object' && thread !== null && 'id' in thread ? thread.id : undefined
  check(typeof id === 'string', 'app-server announced the started thread')
  return id as string
}

const checkDesktopOrigin = (meta: Json): void => {
  check(meta['originator'] === 'Codex Desktop' && meta['source'] === 'vscode', `the thread has originator "Codex Desktop" and source vscode (${String(meta['originator'])})`)
}

const fullAccess = { approvalPolicy: 'never', sandbox: 'danger-full-access' }

const tools = stubScenario({
  name: 'tools',
  surface,
  trust: true,
  expectedFacts: [
    'The ChatGPT.app bundled codex app-server (clientInfo codex_desktop, CODEX_INTERNAL_ORIGINATOR_OVERRIDE "Codex Desktop") runs a thread/start + turn/start turn',
    'The turn runs `echo hi`, applies a patch adding result.json and runs `echo code` from a code-mode exec cell; the rollout has originator "Codex Desktop" and source vscode',
    'Hooks trusted through hooks/list fire for Bash and apply_patch; SessionEnd fires when the client closes stdin',
  ],
  script: { 'desktop-tools': toolSteps },
  run: async ({ session }) => {
    const { stdout } = await runDesktop(session, { thread: fullAccess, prompts: ['[aang:desktop-tools] Run `echo hi`, add result.json with a patch, run `echo code` from a code cell, then reply done.'] })
    const rollout = await rolloutOf(session.codex, rootThread(stdout))
    checkDesktopOrigin(sessionMeta(rollout))
    check(completedItems(rollout, 'CommandExecution').length === 2 && completedItems(rollout, 'FileChange').length === 1, 'both commands and the patch completed')
    check(await exists(join(session.project, 'result.json')), 'result.json was written')
    const hooks = await hookRecords(session.spool)
    check(hooksNamed(hooks, 'PostToolUse', { key: 'tool_name', value: 'Bash' }).length === 2 && hooksNamed(hooks, 'SessionEnd').length === 1, 'trusted hooks fired')
    await session.checkpoint('result-written', { root: 'home', path: 'project/result.json' }, 'result.json appears as the output file of the Desktop stage')
    await session.checkpoint('turn-complete', finished(rollout), 'The Desktop turn completes with three finished actions')
  },
})

const approval = stubScenario({
  name: 'approval',
  surface,
  trust: true,
  expectedFacts: [
    'With approvalPolicy untrusted and a read-only sandbox, `touch approved.txt` (require_escalated) produces item/commandExecution/requestApproval to the client',
    'The PermissionRequest hook is spooled while the request waits; the host accepts after about 1 s',
    'OTel codex.tool_decision reports decision approved, source User, call_id equal to the PreToolUse tool_use_id; the rollout has no record of the wait',
  ],
  script: {
    'desktop-approval': [[shell('touch approved.txt', { sandbox_permissions: 'require_escalated', justification: 'Create approved.txt outside the read-only sandbox' })]],
  },
  run: async ({ session, telemetry }) => {
    const { stdout } = await runDesktop(session, {
      thread: { approvalPolicy: 'untrusted', sandbox: 'read-only' },
      prompts: ['[aang:desktop-approval] Create approved.txt with `touch approved.txt` and ask for approval.'],
    })
    const rollout = await rolloutOf(session.codex, rootThread(stdout))
    check(messages(stdout, 'item/commandExecution/requestApproval').length === 1, 'the client received one command approval request')
    const hooks = await hookRecords(session.spool)
    const started = hooksNamed(hooks, 'PreToolUse', { key: 'tool_name', value: 'Bash' })[0]
    check(hooksNamed(hooks, 'PermissionRequest').length === 1 && started !== undefined, 'PermissionRequest was spooled')
    const decisions = logRecords(telemetry.bodies).filter((record) => record['event.name'] === 'codex.tool_decision')
    check(decisions.some((record) => record['decision'] === 'approved' && record['source'] === 'User' && record['call_id'] === started?.['tool_use_id']),
      `OTel reported a user approval (${JSON.stringify(decisions)})`)
    check(await exists(join(session.project, 'approved.txt')), 'the approved command ran')
    await session.checkpoint('approval-requested', { hook: { event: 'PermissionRequest' } }, 'The Desktop action waits for the user to approve the command')
    await session.checkpoint('approval-granted', { hook: { event: 'PostToolUse' } }, 'The approved command completes and the wait for approval ends')
    await session.checkpoint('turn-complete', finished(rollout), 'The Desktop turn completes after the approved command')
  },
})

const subagent = stubScenario({
  name: 'subagents',
  surface,
  trust: true,
  expectedFacts: subagentFacts,
  script: (session) => subagentScript(session, 'desktop-subagent'),
  run: async ({ session, stub }) => {
    const { stdout } = await runDesktop(session, { thread: fullAccess, prompts: ['[aang:desktop-subagent] Spawn subagents scout and builder, wait for them, then reply done.'] })
    const root = rootThread(stdout)
    const children = await checkSubagents(session, stub.replies, root)
    checkDesktopOrigin(sessionMeta(await rolloutOf(session.codex, root)))
    check(children.every((child) => sessionMeta(child)['originator'] === 'Codex Desktop'), 'the children inherit originator "Codex Desktop"')
    const [first] = children
    if (first !== undefined) await session.checkpoint('child-finished', finished(first), 'A subagent stage finishes under the root Desktop session and its result returns to the parent')
    await session.checkpoint('root-finished', finished(await rolloutOf(session.codex, root)), 'The root Desktop turn completes after waiting for both subagents')
  },
})

export const desktopScenarios: readonly Scenario[] = [tools, approval, subagent]
