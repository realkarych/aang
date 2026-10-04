import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const [mode, target] = process.argv.slice(2)
if (!target) {
  throw new Error('Missing target')
}
const logs = {
  resourceLogs: [{
    resource: { attributes: [{ key: 'service.name', value: { stringValue: 'codex_exec' } }, { key: 'user.email', value: { stringValue: 'someone.personal@example.org' } }] },
    scopeLogs: [{ logRecords: [{ timeUnixNano: '1790856414962000000', attributes: [
      { key: 'event.name', value: { stringValue: 'codex.tool_decision' } },
      { key: 'decision', value: { stringValue: 'approved' } },
      { key: 'source', value: { stringValue: 'User' } },
      { key: 'user.account_id', value: { stringValue: 'acct-private-4477' } },
    ] }] }],
  }],
}
const post = async (contentType: string, body: string): Promise<void> => {
  const response = await fetch(target, { method: 'POST', headers: { 'content-type': contentType }, body })
  await response.arrayBuffer()
}
const rollout = (cwd: string, id: string): string => `${JSON.stringify({ timestamp: '2026-10-03T09:00:00.000Z', type: 'session_meta', payload: { id, cwd, cli_version: '0.0.1' } })}\n`
switch (mode) {
  case 'otlp':
    await post('application/json', JSON.stringify(logs))
    process.stdout.write(`posted ${String(process.env['AANG_SCENARIO_MARK'])}`)
    break
  case 'protobuf':
    await post('application/x-protobuf', 'binary')
    break
  case 'invalid':
    await post('application/json', '{"resourceLogs":')
    break
  case 'regular': {
    const codexHome = process.env['CODEX_HOME']
    if (!codexHome) throw new Error('Missing CODEX_HOME')
    const day = join(codexHome, 'sessions', '2026', '10', '03')
    await mkdir(day, { recursive: true })
    await writeFile(join(day, 'rollout-own.jsonl'), rollout(process.cwd(), target))
    await appendFile(join(day, 'rollout-own.jsonl'), `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } })}\n`)
    await writeFile(join(day, 'rollout-foreign.jsonl'), rollout('/Users/someone-else/elsewhere', 'thread-foreign-1'))
    await writeFile(join(day, 'rollout-partial.jsonl'), '{"type":"session_meta"')
    await appendFile(join(codexHome, 'sessions', 'existing.jsonl'), `${JSON.stringify({ type: 'event_msg', payload: { type: 'later' } })}\n`)
    process.stdout.write(JSON.stringify({ home: process.env['HOME'], codexHome }))
    break
  }
  case 'regular-claude': {
    const home = process.env['HOME'] ?? ''
    const claude = join(home, '.claude')
    const project = join(claude, 'projects', process.cwd().replaceAll(/[^a-zA-Z0-9]/g, '-'))
    const foreign = '9d0c51f4-6d0e-4b5e-8f3a-2f6f0f4a7c11'
    const line = (value: unknown): string => `${JSON.stringify(value)}\n`
    const write = async (path: string, content: string): Promise<void> => {
      await mkdir(join(path, '..'), { recursive: true })
      await writeFile(path, content)
    }
    await mkdir(join(project, 'memory'), { recursive: true })
    await write(join(claude, 'sessions', `${String(process.pid)}.json`), JSON.stringify({ pid: process.pid, sessionId: target, cwd: process.cwd() }))
    await write(join(project, `${target}.jsonl`), line({ type: 'user', sessionId: target, cwd: process.cwd(), message: { role: 'user', content: `Read ${join(claude, 'settings.json')}` } }))
    await write(join(project, target, 'subagents', 'agent-a1.jsonl'), line({ type: 'user', sessionId: target, agentId: 'a1', isSidechain: true }))
    await write(join(claude, 'tasks', target, '1.json'), JSON.stringify({ id: '1', subject: 'Own task', status: 'pending' }))
    await mkdir(join(claude, 'session-env', target), { recursive: true })
    await write(join(claude, 'projects', '-Users-someone-else-elsewhere', `${foreign}.jsonl`), line({ type: 'user', sessionId: foreign, cwd: '/Users/someone-else/elsewhere' }))
    await write(join(claude, 'sessions', '2.json'), JSON.stringify({ pid: 2, sessionId: foreign, cwd: '/Users/someone-else/elsewhere' }))
    await write(join(claude, 'tasks', foreign, '1.json'), JSON.stringify({ id: '1', subject: 'Foreign task', status: 'pending' }))
    await write(join(claude, 'teams', 'team-new', 'config.json'), JSON.stringify({ name: 'team-new', leadSessionId: target }))
    await appendFile(join(claude, 'projects', '-Users-someone-else-old', `${foreign}.jsonl`), line({ type: 'later' }))
    process.stdout.write(JSON.stringify({ home, claudeConfigDir: process.env['CLAUDE_CONFIG_DIR'] ?? null, pid: process.pid }))
    break
  }
  case 'append':
    await appendFile(join(process.cwd(), 'events.jsonl'), `${JSON.stringify({ type: 'event', word: target })}\n`)
    break
  case 'tasks': {
    const tasks = join(String(process.env['CLAUDE_CONFIG_DIR']), 'tasks', target)
    await mkdir(tasks, { recursive: true })
    await writeFile(join(tasks, '1.json'), JSON.stringify({ id: '1', subject: 'Write the report', status: 'in_progress' }))
    break
  }
  case 'fail':
    process.stderr.write(`noise\n${'x'.repeat(3_000)}\nthe engine reported ${target}\n`)
    process.exitCode = 3
    break
  default:
    throw new Error(`Unknown mode ${String(mode)}`)
}
