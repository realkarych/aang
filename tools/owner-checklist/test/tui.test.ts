import { execFile, spawn } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { describe, test } from 'vitest'
import {
  collect,
  createSandbox,
  encodeProjectPath,
  handlerFor,
  handlerInvoker,
  lineWith,
  prepare,
  readJson,
  record,
  resultFiles,
  runChecklist,
  runProcess,
  sample,
  type Sandbox,
  sectionOf,
  type Step,
  writeJsonLines,
} from './checklist.js'

const execFileAsync = promisify(execFile)
const sessionId = '5f0c2a8e-9d1b-4c3e-8a7f-2b6d4e1f0a93'
const secret = 'SECRET'

interface ChecklistPaths {
  readonly dir: string
  readonly pluginDir: string
  readonly spoolReady: string
  readonly probeRepo: string
  readonly transcript: string
}

const pathsOf = async (sandbox: Sandbox): Promise<ChecklistPaths> => {
  const dir = await readJson<{ dir: string }>(join(sandbox.dir, 'state.json')).then((state) => state.dir)
  const probeRepo = join(dir, 'probe-repo')
  return {
    dir,
    pluginDir: join(dir, 'aang-home', 'claude-plugin'),
    spoolReady: join(dir, 'aang-home', 'spool', 'new'),
    probeRepo,
    transcript: join(sandbox.claudeConfigDir, 'projects', encodeProjectPath(probeRepo), `${sessionId}.jsonl`),
  }
}

const tuiSteps = async (paths: ChecklistPaths): Promise<Step[]> => {
  const common = { session_id: sessionId, transcript_path: paths.transcript, cwd: paths.probeRepo }
  const at = (seconds: number, payload: Record<string, unknown>): Step => ({ at: seconds, payload: { ...payload, ...common } })
  const tool = (event: string, name: string, id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    hook_event_name: event,
    tool_name: name,
    tool_use_id: id,
    permission_mode: 'default',
    ...extra,
  })
  const questions = [
    { question: `${secret} question one?`, header: 'One', options: [{ label: 'a' }, { label: 'b' }], multiSelect: false },
    { question: `${secret} question two?`, header: 'Two', options: [{ label: 'c' }, { label: 'd' }], multiSelect: false },
  ]
  const plan = `${secret} plan: create aang-plan.txt`
  const planFile = join(paths.probeRepo, '.claude', 'plans', 'aang.md')
  return [
    at(0, await sample('SessionStart.startup.json')),
    at(1, { ...(await sample('UserPromptSubmit.json')), prompt: `${secret} prompt text` }),
    at(2, tool('PreToolUse', 'Bash', 'toolu_allow', { tool_input: { command: `touch aang-perm-allow.txt # ${secret}` } })),
    at(2.05, { ...(await sample('PermissionRequest.Bash.json')), tool_input: { command: `touch ${secret}` } }),
    at(8.05, await sample('Notification.permission_prompt.json')),
    at(12, tool('PostToolUse', 'Bash', 'toolu_allow', { tool_response: { stdout: `${secret} output`, stderr: '' }, duration_ms: 12 })),
    at(13, tool('PreToolUse', 'Bash', 'toolu_deny', { tool_input: { command: 'touch aang-perm-deny.txt' } })),
    at(13.1, { ...(await sample('PermissionRequest.Bash.json')), tool_input: { command: 'touch aang-perm-deny.txt' } }),
    at(15, {
      hook_event_name: 'PostToolBatch',
      tool_calls: [{ tool_name: 'Bash', tool_use_id: 'toolu_deny', tool_input: {}, tool_response: `${secret} denied` }],
    }),
    at(20, tool('PreToolUse', 'AskUserQuestion', 'toolu_ask', { tool_input: { questions } })),
    at(20.5, tool('PermissionRequest', 'AskUserQuestion', 'toolu_ask', { tool_input: { questions } })),
    at(26.5, { hook_event_name: 'Notification', notification_type: 'elicitation_dialog', message: secret }),
    at(30, tool('PostToolUse', 'AskUserQuestion', 'toolu_ask', {
      tool_input: { questions },
      tool_response: { questions, answers: { [`${secret} question one?`]: 'a', [`${secret} question two?`]: 'd' } },
    })),
    at(31, tool('PreToolUse', 'ExitPlanMode', 'toolu_plan', { tool_input: { plan, planFilePath: planFile } })),
    at(31.25, tool('PermissionRequest', 'ExitPlanMode', 'toolu_plan', { tool_input: { plan, planFilePath: planFile } })),
    at(35, tool('PostToolUse', 'ExitPlanMode', 'toolu_plan', { tool_response: { plan, filePath: planFile } })),
    at(40, { ...(await sample('Stop.json')), last_assistant_message: `${secret} final` }),
    at(100, { hook_event_name: 'Notification', notification_type: 'idle_prompt', message: secret }),
    at(110, { hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' }),
  ]
}

const writeTranscript = async (paths: ChecklistPaths): Promise<void> => {
  const line = (extra: Record<string, unknown>) => ({ sessionId, entrypoint: 'cli', version: '2.1.287', cwd: paths.probeRepo, ...extra })
  await writeJsonLines(paths.transcript, [
    line({ type: 'user', message: { role: 'user', content: `${secret} prompt text` } }),
    line({ type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted' }),
  ])
  await writeJsonLines(join(paths.transcript.replace(/\.jsonl$/, ''), 'subagents', 'agent-a1.jsonl'), [line({ type: 'user' })])
}

const pluginEnv = (paths: ChecklistPaths): Record<string, string> => ({
  CLAUDE_CODE_ENTRYPOINT: 'cli',
  CLAUDE_CODE_SESSION_ID: sessionId,
  CLAUDE_PLUGIN_ROOT: paths.pluginDir,
  CLAUDE_PROJECT_DIR: paths.probeRepo,
  CLAUDE_CODE_MESSAGING_TOKEN: `${secret}-token`,
})

const jsonText = (value: string): string => JSON.stringify(value).slice(1, -1)

describe('owner checklist for the interactive Claude TUI', () => {
  test('prepare registers the real aang-hook through --plugin-dir and collect reports items (a)–(h) without prompts or tool output', async ({
    expect,
    onTestFinished,
  }) => {
    const sandbox = await createSandbox(onTestFinished)
    const prepared = await prepare(sandbox, ['--claude', 'plugin-dir', '--hours', '2'])
    expect(prepared.stderr).toBe('')
    expect(prepared.status).toBe(0)
    const paths = await pathsOf(sandbox)
    expect(prepared.stdout).toContain('--plugin-dir')
    expect(prepared.stdout).toContain(paths.pluginDir)

    const spoolNames = await readdir(join(paths.dir, 'aang-home', 'spool'))
    const lease = spoolNames.find((name) => name.startsWith('lease-'))
    const expiry = Number(lease?.slice('lease-'.length))
    expect(expiry - Date.now() / 1000).toBeGreaterThan(2 * 3600 - 120)
    expect(expiry - Date.now() / 1000).toBeLessThanOrEqual(2 * 3600)
    expect(spoolNames).not.toContain('stopped')
    const commits = await execFileAsync('git', ['rev-list', '--count', 'HEAD'], { cwd: paths.probeRepo })
    expect(commits.stdout.trim()).toBe('1')

    await writeTranscript(paths)
    const hooksFile = join(paths.pluginDir, 'hooks', 'hooks.json')
    await record(paths.spoolReady, async (payload) => {
      const event = typeof payload.hook_event_name === 'string' ? payload.hook_event_name : ''
      return handlerInvoker(await handlerFor(hooksFile, event), pluginEnv(paths))(payload)
    }, await tuiSteps(paths))

    const envProbe = await handlerFor(join(paths.dir, 'probes', 'env-settings.json'), 'SessionStart')
    expect(envProbe.command).toBe(process.execPath)
    const probed = await handlerInvoker(envProbe, {
      CLAUDE_CODE_SESSION_ATTENDED: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_SESSION_ID: sessionId,
    })({ ...(await sample('SessionStart.startup.json')), session_id: sessionId })
    expect(probed).toEqual({ status: 0, stdout: '', stderr: '' })

    const collected = await collect(sandbox)
    expect(collected.stderr).toBe('')
    expect(collected.status).toBe(0)
    const files = await resultFiles(paths.dir)
    const events = (files['events.jsonl'] ?? '').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(events).toHaveLength(19)
    expect(events[0]).toMatchObject({
      received_at: '2026-10-03T10:00:00.000000000Z',
      runtime: 'claude',
      registration: 'plugin',
      hook_event_name: 'SessionStart',
      session_id: sessionId,
      source: 'startup',
      cwd: join('<dir>', 'probe-repo'),
      env: {
        CLAUDE_CODE_ENTRYPOINT: 'cli',
        CLAUDE_CODE_SESSION_ID: sessionId,
        CLAUDE_PLUGIN_ROOT: join('<dir>', 'aang-home', 'claude-plugin'),
        CLAUDE_PROJECT_DIR: join('<dir>', 'probe-repo'),
      },
    })
    expect(events[0]?.transcript_path).toBe(join('~', '.claude', 'projects', '<dir>-probe-repo', `${sessionId}.jsonl`))
    expect(events.find((event) => event.hook_event_name === 'PreToolUse' && event.tool_name === 'AskUserQuestion')).toMatchObject({ questions: 2 })
    expect(events.find((event) => event.hook_event_name === 'PostToolUse' && event.tool_name === 'AskUserQuestion')).toMatchObject({ answers: true })
    expect(events.find((event) => event.hook_event_name === 'PreToolUse' && event.tool_name === 'ExitPlanMode')).toMatchObject({
      plan_length: `${secret} plan: create aang-plan.txt`.length,
      plan_file_path: true,
    })
    expect(events.find((event) => event.hook_event_name === 'PostToolBatch')).toMatchObject({
      tool_calls: [{ tool_name: 'Bash', tool_use_id: 'toolu_deny', response: 'text' }],
    })
    expect(events.find((event) => event.hook_event_name === 'Stop')).toMatchObject({ background_tasks: 0 })

    for (const [name, text] of Object.entries(files)) {
      expect(text, name).not.toContain(secret)
      expect(text, name).not.toContain(sandbox.root)
      expect(text, name).not.toContain(jsonText(sandbox.root))
    }

    const summary = files['summary.md'] ?? ''
    const permission = sectionOf(summary, '### (a) Notification(permission_prompt) после PermissionRequest')
    expect(lineWith(permission, 'toolu_allow')).toMatch(/\| 6\.00 \| разрешено \(PostToolUse\) \|$/)
    expect(lineWith(permission, 'toolu_deny')).toMatch(/\| нет \| отклонено \(есть в PostToolBatch, нет Post\*\) \|$/)
    expect(lineWith(permission, 'toolu_ask')).toMatch(/\| нет \| разрешено \(PostToolUse\) \|$/)
    expect(lineWith(sectionOf(summary, '### (b) Notification(idle_prompt) после Stop'), '| S1 |')).toMatch(/\| 40\.00 \| 0 \| 60\.00 \|$/)
    expect(lineWith(sectionOf(summary, '### (c) AskUserQuestion'), 'toolu_ask')).toBe(
      '| S1 | cli | toolu_ask | 2 | да | elicitation_dialog | PostToolUse | да | 10.00 |',
    )
    expect(summary).toContain('### (d) Ошибки hook и зависший hook — заполняет владелец')
    expect(lineWith(sectionOf(summary, '### (e) SessionEnd.reason'), '| S1 |')).toContain('| prompt_input_exit |')
    expect(lineWith(sectionOf(summary, '### (f) Окружение процесса hook (`results/env-probe.jsonl`)'), '| S1 |')).toMatch(
      /\| SessionStart \| startup \| 1 \| cli \|/,
    )
    const notifications = sectionOf(summary, '### (g) Типы Notification')
    expect(lineWith(notifications, '| idle_prompt |')).toContain('| 1 | S1 (cli) |')
    expect(lineWith(notifications, '| permission_prompt |')).toContain('| 1 |')
    expect(notifications).toContain('- `elicitation_dialog`: встречен.')
    expect(notifications).toContain('- `agent_needs_input`: не встречен.')
    expect(lineWith(sectionOf(summary, '### (h) ExitPlanMode'), 'toolu_plan')).toBe(
      `| S1 | cli | toolu_plan | ${String(`${secret} plan: create aang-plan.txt`.length)} | да | да | нет | PostToolUse | 4.00 |`,
    )
    expect(lineWith(sectionOf(summary, '## Транскрипты Claude'), '| S1 |')).toMatch(/\| 2 \| cli ×2 \| 2\.1\.287 \| 1 \| 1 \|$/)

    const repeated = await collect(sandbox)
    expect(repeated.status).toBe(0)
    expect((await resultFiles(paths.dir))['events.jsonl']).toBe(files['events.jsonl'])

    const cleaned = await runChecklist(sandbox, ['cleanup', '--dir', sandbox.dir, '--keep-results', '--claude-config-dir', sandbox.claudeConfigDir])
    expect(cleaned.stderr).toBe('')
    expect(cleaned.status).toBe(0)
    expect(cleaned.stdout).toContain(paths.transcript)
    expect(await readdir(paths.dir)).toEqual(['results'])
    expect(Object.keys(await resultFiles(paths.dir)).sort()).toEqual(['env-probe.jsonl', 'events.jsonl', 'files.json', 'summary.md'])
  })

  test('the failure probes for item (d) fail PreToolUse with exit code 1 and hang UserPromptSubmit past its 2 s timeout', async ({
    expect,
    onTestFinished,
  }) => {
    const sandbox = await createSandbox(onTestFinished)
    expect((await prepare(sandbox, ['--claude', 'plugin-dir'])).status).toBe(0)
    const paths = await pathsOf(sandbox)
    const settings = join(paths.dir, 'probes', 'failure-settings.json')

    const failing = await handlerFor(settings, 'PreToolUse')
    const failed = await runProcess(failing.command, failing.args, {}, JSON.stringify(await sample('PreToolUse.Bash.json')))
    expect(failed.status).toBe(1)
    expect(failed.stdout).toBe('')
    expect(failed.stderr).toContain('aang D.7')

    const hanging = await handlerFor(settings, 'UserPromptSubmit')
    expect(hanging).toMatchObject({ command: process.execPath, timeout: 2, statusMessage: expect.stringContaining('aang D.7') as unknown })
    const child = spawn(hanging.command, [...hanging.args], { stdio: ['pipe', 'ignore', 'ignore'] })
    onTestFinished(() => {
      child.kill()
    })
    child.stdin.end(JSON.stringify(await sample('UserPromptSubmit.json')))
    await delay((hanging.timeout + 0.5) * 1000)
    expect(child.exitCode).toBeNull()
  })

  test('collect and cleanup skip sessions whose cwd is outside the checklist directory unless --all-sessions is given', async ({
    expect,
    onTestFinished,
  }) => {
    const sandbox = await createSandbox(onTestFinished)
    expect((await prepare(sandbox, ['--claude', 'plugin-dir'])).status).toBe(0)
    const paths = await pathsOf(sandbox)
    const privateProject = join(sandbox.home, 'src', 'private-project')
    const otherSession = '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f'
    const otherTranscript = join(sandbox.claudeConfigDir, 'projects', encodeProjectPath(privateProject), `${otherSession}.jsonl`)
    await writeJsonLines(otherTranscript, [{ sessionId: otherSession, entrypoint: 'cli', type: 'user' }])
    await writeTranscript(paths)
    const hooksFile = join(paths.pluginDir, 'hooks', 'hooks.json')
    const invoke = async (payload: Readonly<Record<string, unknown>>) =>
      handlerInvoker(await handlerFor(hooksFile, 'SessionStart'), pluginEnv(paths))(payload)
    await record(paths.spoolReady, invoke, [
      { at: 0, payload: { hook_event_name: 'SessionStart', source: 'startup', session_id: sessionId, cwd: paths.probeRepo, transcript_path: paths.transcript } },
      { at: 1, payload: { hook_event_name: 'SessionStart', source: 'startup', session_id: otherSession, cwd: privateProject, transcript_path: otherTranscript } },
    ])

    expect((await collect(sandbox)).status).toBe(0)
    const scoped = await resultFiles(paths.dir)
    for (const text of Object.values(scoped)) {
      expect(text).not.toContain(otherSession)
      expect(text).not.toContain('private-project')
    }
    expect(scoped['summary.md']).toContain('остальные отброшены: событий 1, сессий 1.')

    const all = await runChecklist(sandbox, ['collect', '--dir', sandbox.dir, '--all-sessions', '--claude-desktop-dir', sandbox.desktopDir])
    expect(all.status).toBe(0)
    expect((await resultFiles(paths.dir))['events.jsonl']).toContain(otherSession)

    const cleaned = await runChecklist(sandbox, ['cleanup', '--dir', sandbox.dir])
    expect(cleaned.status).toBe(0)
    expect(cleaned.stdout).toContain(paths.transcript)
    expect(cleaned.stdout).not.toContain(otherTranscript)
  })
})
