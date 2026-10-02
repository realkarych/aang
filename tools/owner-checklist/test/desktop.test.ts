import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
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
  runProcess,
  type Sandbox,
  sectionOf,
  writeJsonLines,
} from './checklist.js'

const claudeSession = '0b6c7f4e-1d2a-4e3b-9c8d-7a6f5e4d3c2b'
const hostSession = 'local_3e2d1c0b-a987-4654-b321-0fedcba98765'
const unrelatedSession = '9a8b7c6d-5e4f-4321-8765-43210fedcba9'
const codexSession = '01a0f75e-49bf-79a3-b3ea-33487e3255d8'
const secret = 'SECRET'
const seedPrompt = `${secret} seed prompt with several words`

interface Paths {
  readonly dir: string
  readonly pluginDir: string
  readonly spool: string
  readonly probeRepo: string
  readonly worktree: string
}

const pathsOf = async (sandbox: Sandbox): Promise<Paths> => {
  const { dir } = await readJson<{ dir: string }>(join(sandbox.dir, 'state.json'))
  const probeRepo = join(dir, 'probe-repo')
  return {
    dir,
    pluginDir: join(dir, 'aang-home', 'claude-plugin'),
    spool: join(dir, 'aang-home', 'spool'),
    probeRepo,
    worktree: join(probeRepo, '.claude', 'worktrees', 'brave-otter'),
  }
}

const recordDesktopSession = async (sandbox: Sandbox, paths: Paths): Promise<void> => {
  const transcript = join(sandbox.claudeConfigDir, 'projects', encodeProjectPath(paths.worktree), `${claudeSession}.jsonl`)
  const line = (extra: Record<string, unknown>) => ({ sessionId: claudeSession, entrypoint: 'claude-desktop', version: '2.1.284', ...extra })
  await writeJsonLines(transcript, [line({ type: 'user', message: { content: `${secret} desktop prompt` } }), line({ type: 'system', subtype: 'compact_boundary' })])
  const common = { session_id: claudeSession, transcript_path: transcript, cwd: paths.worktree }
  const hooksFile = join(paths.pluginDir, 'hooks', 'hooks.json')
  const env = {
    CLAUDE_CODE_ENTRYPOINT: 'claude-desktop',
    CLAUDE_CODE_HOST_SESSION_ID: hostSession,
    CLAUDE_PLUGIN_ROOT: join(sandbox.claudeConfigDir, 'plugins', 'cache', 'aang', 'aang', '1.0.0'),
  }
  const steps = [
    { hook_event_name: 'SessionStart', source: 'startup' },
    { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'toolu_d1', tool_input: { command: `echo ${secret}` } },
    { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'toolu_d1', tool_response: { stdout: secret } },
    { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'toolu_d2', tool_input: { command: 'touch aang-perm-deny.txt' } },
    { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'touch aang-perm-deny.txt' } },
    { hook_event_name: 'PostToolBatch', tool_calls: [{ tool_name: 'Bash', tool_use_id: 'toolu_d2', tool_response: `${secret} denied` }] },
    { hook_event_name: 'PreCompact', trigger: 'manual', custom_instructions: secret },
    { hook_event_name: 'SessionStart', source: 'compact' },
    { hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'general-purpose' },
    { hook_event_name: 'SubagentStop', agent_id: 'a1', agent_type: 'general-purpose', last_assistant_message: secret },
  ]
  await record(join(paths.spool, 'new'), async (payload) => {
    const event = typeof payload.hook_event_name === 'string' ? payload.hook_event_name : ''
    return handlerInvoker(await handlerFor(hooksFile, event), env)(payload)
  }, steps.map((payload, index) => ({ at: index, payload: { ...payload, ...common } })))
}

const writeDesktopMetadata = async (sandbox: Sandbox, paths: Paths): Promise<void> => {
  const directory = join(sandbox.desktopDir, 'c4f1e2d3-account', '7a8b9c0d-org')
  await mkdir(directory, { recursive: true })
  const uuid = hostSession.slice('local_'.length)
  await writeFile(
    join(directory, `${hostSession}.json`),
    JSON.stringify({
      sessionId: hostSession,
      cliSessionId: claudeSession,
      cwd: paths.worktree,
      title: `${secret} title`,
      isArchived: false,
      completedTurns: 3,
      postTurnSummary: { status_category: 'done', needs_action: `${secret} summary` },
      spawnSeed: { parentSessionId: 'local_11111111-2222-4333-8444-555555555555', prompt: seedPrompt },
      lastSpawnRootDetected: true,
    }),
  )
  await writeFile(
    join(directory, 'local_99999999-8888-4777-8666-555555555555.json'),
    JSON.stringify({ sessionId: 'local_99999999-8888-4777-8666-555555555555', cliSessionId: unrelatedSession, title: 'UNRELATED' }),
  )
  await writeFile(join(directory, `deleted_${uuid}`), '1791021600000')
}

const recordCodexSession = async (sandbox: Sandbox, paths: Paths): Promise<void> => {
  const rollout = join(sandbox.codexHome, 'sessions', '2026', '10', '03', `rollout-2026-10-03T10-00-00-${codexSession}.jsonl`)
  await writeJsonLines(rollout, [
    {
      type: 'session_meta',
      payload: { id: codexSession, cwd: paths.probeRepo, originator: 'Codex Desktop', source: 'vscode', thread_source: 'user', cli_version: '0.159.2' },
    },
    {
      type: 'turn_context',
      payload: {
        cwd: paths.probeRepo,
        approval_policy: 'on-request',
        sandbox_policy: { type: 'workspace-write', writable_roots: [paths.probeRepo] },
        workspace_roots: [paths.probeRepo],
      },
    },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `${secret} codex prompt` }] } },
  ])
  const common = { session_id: codexSession, transcript_path: rollout, cwd: paths.probeRepo, model: 'gpt-6.1-sol' }
  const steps = [
    { hook_event_name: 'SessionStart', source: 'startup', permission_mode: 'default' },
    { hook_event_name: 'UserPromptSubmit', turn_id: 't1', prompt: `${secret} codex prompt` },
    { hook_event_name: 'PreToolUse', turn_id: 't1', tool_name: 'Bash', tool_use_id: 'call_1', tool_input: { command: 'touch allow.txt' } },
    { hook_event_name: 'PermissionRequest', turn_id: 't1', tool_name: 'Bash', tool_input: { command: 'touch allow.txt' } },
    { hook_event_name: 'PostToolUse', turn_id: 't1', tool_name: 'Bash', tool_use_id: 'call_1', tool_response: secret },
    { hook_event_name: 'Stop', turn_id: 't1', last_assistant_message: secret },
  ]
  const deployed = join(paths.dir, 'aang-home', 'bin', process.platform === 'win32' ? 'aang-hook.exe' : 'aang-hook')
  const env = { CODEX_HOME: sandbox.codexHome, CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'Codex Desktop' }
  const invoke = (payload: Readonly<Record<string, unknown>>) =>
    runProcess(deployed, ['codex', 'user', paths.spool], env, JSON.stringify(payload))
  await record(join(paths.spool, 'new'), invoke, steps.map((payload, index) => ({ at: 100 + index, payload: { ...payload, ...common } })))
}

describe('owner checklist for Claude Desktop and Codex Desktop data', () => {
  test('collect links Desktop metadata, transcripts and Codex rollouts of spooled sessions only and keeps their content out', async ({
    expect,
    onTestFinished,
  }) => {
    const sandbox = await createSandbox(onTestFinished)
    expect((await prepare(sandbox, ['--claude', 'plugin-dir'])).status).toBe(0)
    const paths = await pathsOf(sandbox)
    await recordDesktopSession(sandbox, paths)
    await writeDesktopMetadata(sandbox, paths)
    await recordCodexSession(sandbox, paths)

    const collected = await collect(sandbox)
    expect(collected.stderr).toBe('')
    expect(collected.status).toBe(0)
    const files = await resultFiles(paths.dir)
    for (const [name, text] of Object.entries(files)) {
      expect(text, name).not.toContain(secret)
      expect(text, name).not.toContain('UNRELATED')
      expect(text, name).not.toContain(unrelatedSession)
      expect(text, name).not.toContain('c4f1e2d3-account')
    }
    const summary = files['summary.md'] ?? ''

    const desktop = sectionOf(summary, '### S1')
    expect(desktop).toContain(`CLAUDE_CODE_ENTRYPOINT: claude-desktop; CLAUDE_CODE_HOST_SESSION_ID: ${hostSession}`)
    expect(desktop).toContain('- SessionStart.source: startup, compact')
    expect(desktop).toContain('- PreCompact: 1, PostCompact: 0')
    expect(desktop).toContain('- SubagentStart: 1, SubagentStop: 1')
    expect(desktop).toContain('- cwd в `.claude/worktrees`: да')
    expect(desktop).toContain('пар 1, PostToolUseFailure 0, без Post*: Bash toolu_d2 (отказ в PostToolBatch)')
    expect(desktop).toContain('- PermissionRequest: Bash → отклонено (есть в PostToolBatch, нет Post*)')
    expect(desktop).toContain('- entrypoint в записях: claude-desktop ×2; версии: 2.1.284')
    expect(desktop).toContain('- compact_boundary: 1;')

    const metadata = sectionOf(summary, '### Метаданные Desktop (`claude-code-sessions/**/local_*.json`)')
    expect(metadata).toContain(`#### \`*/*/${hostSession}.json\``)
    expect(metadata).toContain(`- sessionId: ${hostSession}; cliSessionId: ${claudeSession}; сессия в spool: S1`)
    expect(metadata).toContain('- lastSpawnRootDetected: true')
    expect(lineWith(metadata, '- spawnSeed:')).toBe(
      `- spawnSeed: \`{"parentSessionId":"local_11111111-2222-4333-8444-555555555555","prompt":"<text, ${String(seedPrompt.length)} chars>"}\``,
    )
    expect(metadata).toContain('"title": "str"')
    expect(metadata).toContain('"cliSessionId": "str<uuid>"')
    expect(lineWith(sectionOf(summary, '### Маркеры удаления `deleted_<uuid>`'), hostSession)).toBe(
      `| */*/deleted_${hostSession.slice('local_'.length)} | ${hostSession} | 1791021600000 |`,
    )

    const codex = sectionOf(summary, '### S2')
    expect(codex).toContain('- SessionStart.source: startup')
    expect(codex).toContain('пар 1, PostToolUseFailure 0, без Post*: нет')
    expect(codex).toContain('- PermissionRequest: Bash → разрешено (PostToolUse)')
    expect(codex).toContain(
      '- session_meta: originator `"Codex Desktop"`, source `"vscode"`, thread_source `"user"`, parent_thread_id `null`, cli_version `"0.159.2"`',
    )
    expect(codex).toContain('`~/aang-desktop-probe-outside` среди корней записи: нет')
    expect(codex).toContain(`- Rollout: \`${join('~', '.codex', 'sessions', '2026', '10', '03', `rollout-2026-10-03T10-00-00-${codexSession}.jsonl`)}\``)

    const events = (files['events.jsonl'] ?? '').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(events.filter((event) => event.runtime === 'codex')).toHaveLength(6)
    expect(events.find((event) => event.runtime === 'codex')).toMatchObject({
      registration: 'user',
      env: { CODEX_HOME: join('~', '.codex'), CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'Codex Desktop' },
    })
    expect(events.find((event) => event.session_id === claudeSession)).toMatchObject({
      env: { CLAUDE_PLUGIN_ROOT: join('~', '.claude', 'plugins', 'cache', 'aang', 'aang', '1.0.0') },
      cwd: join('<dir>', 'probe-repo', '.claude', 'worktrees', 'brave-otter'),
    })
    const filesJson = JSON.parse(files['files.json'] ?? '{}') as { desktopSessions: unknown[]; desktopDeleted: unknown[] }
    expect(filesJson.desktopSessions).toHaveLength(1)
    expect(filesJson.desktopDeleted).toHaveLength(1)
  })
})
