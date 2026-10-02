import { execFileSync } from 'node:child_process'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const [runtime, phase] = process.argv.slice(2)
const required = (name: string): string => {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing ${name}`)
  }
  return value
}
const home = required('HOME')
const claude = required('CLAUDE_CONFIG_DIR')
const codex = required('CODEX_HOME')
const project = process.cwd()
const privateValues = {
  email: 'someone.personal@example.org',
  creator_account_id: 'acct-private-4477',
  organizationUuid: '71c972de-4083-4efa-8fc8-5eab7de93f12',
  installation_id: 'installation-private-22',
  creator_user_id: 'user-private-88',
}
const transcript = runtime === 'claude'
  ? join(claude, 'projects', 'record-project', 'session.jsonl')
  : join(codex, 'sessions', '2026', '10', '02', 'rollout.jsonl')
await mkdir(dirname(transcript), { recursive: true })
if (phase === 'first') {
  await writeFile(join(codex, 'auth.json'), JSON.stringify({ token: 'never-copy-authorization' }))
  const record = {
    type: runtime === 'claude' ? 'user' : 'session_meta',
    sessionId: 'session-public-1',
    uuid: 'event-public-1',
    timestamp: '2026-10-02T09:00:00.000Z',
    cwd: project,
    ...privateValues,
    repeated: `account ${privateValues.creator_account_id}; org ${privateValues.organizationUuid}`,
    windows: 'C:\\Users\\Имя Фамилия\\work\\file.ts',
    windowsJson: JSON.stringify({ path: 'C:\\Users\\Имя Фамилия\\work\\file.ts', account_id: 'acct-nested-99' }),
    windowsProfile: '%USERPROFILE%\\work\\file.ts',
    unix: ['/Users/real-person/work', '/home/another-person/work', home],
    payload: { id: 'thread-public-1', cwd: project, cli_version: '0.0.1' },
    attributes: [{ key: 'user.account_uuid', value: { stringValue: 'acct-otel-77' } }],
  }
  await writeFile(transcript, `${JSON.stringify(record)}\r\n`)
  await writeFile(join(project, 'result.json'), JSON.stringify({ state: 'running', ...privateValues }))
} else {
  await appendFile(transcript, `${JSON.stringify({ type: 'assistant', sessionId: 'session-public-1', uuid: 'event-public-2', message: { content: 'done', usage: { input_tokens: 7, output_tokens: 3 } } })}\r\n`)
  await writeFile(join(project, 'result.json'), JSON.stringify({ state: 'done', ...privateValues }))
}
if (runtime === 'claude') {
  const pluginIndex = process.argv.indexOf('--plugin-dir')
  const plugin = process.argv[pluginIndex + 1]
  if (pluginIndex < 0 || !plugin) {
    throw new Error('No recording plugin')
  }
  const configuration = JSON.parse(await readFile(join(plugin, 'hooks', 'hooks.json'), 'utf8')) as {
    hooks: Record<string, { hooks: { command: string; args: string[]; timeout: number }[] }[]>
  }
  const hook = configuration.hooks['PostToolUse']?.[0]?.hooks[0]
  if (!hook || hook.timeout !== 2) {
    throw new Error('No synchronous recording hook')
  }
  execFileSync(hook.command, hook.args, {
    input: JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'session-public-1', tool_use_id: `tool-${String(phase)}`, cwd: project, transcript_path: transcript, tool_response: privateValues }),
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: plugin, CLAUDE_PROJECT_DIR: project },
  })
}
process.stdout.write(JSON.stringify(privateValues))
if (phase === 'fail') {
  process.exitCode = 7
}
