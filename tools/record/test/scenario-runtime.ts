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
  case 'rules': {
    const codexHome = process.env['CODEX_HOME']
    if (!codexHome) throw new Error('Missing CODEX_HOME')
    const day = join(codexHome, 'sessions', '2026', '10', '04')
    await mkdir(day, { recursive: true })
    const tool = ['/opt/owner-tools/bin/tool', 'view']
    const add = ['git', 'add', 'pkg/private-project/main.go']
    const commit = ['git', 'commit', '-m', 'private commit text']
    const listed = [commit, tool].map((prefix) => `- [${prefix.map((part) => JSON.stringify(part)).join(', ')}]`).join('\n')
    const records = [
      { type: 'session_meta', payload: { id: target, cwd: process.cwd() } },
      { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: `<permissions instructions>\n## Approved command prefixes\nThe following prefix rules have already been approved: ${listed}\n\nApproval policy is \`on-request\`.\n</permissions instructions>` }] } },
      { type: 'world_state', payload: { full: true, state: { permissions: { instructions: 'fed2f53df24dd05a', approved_command_prefixes: [tool, add, commit] } } } },
      { type: 'event_msg', payload: { type: 'exec_approval_request', proposed_execpolicy_amendment: ['touch', 'approved.txt'] } },
    ]
    await writeFile(join(day, 'rollout-rules.jsonl'), records.map((record) => `${JSON.stringify(record)}\n`).join(''))
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
