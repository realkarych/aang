import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { claudeAdapter } from '@aang/adapter-claude'
import { codexAdapter } from '@aang/adapter-codex'
import { StreamKey } from '@aang/contract'
import type { Sandbox } from './sandbox.js'

export const sessions = [
  {
    runtime: 'claude',
    adapter: claudeAdapter,
    stream: StreamKey.parse('["claude","session-1","main"]'),
    path: (sandbox: Sandbox): string => join(sandbox.claude, 'projects', '-project', 'session-1.jsonl'),
    lines: [
      JSON.stringify({ type: 'user', sessionId: 'session-1', uuid: 'u-1', message: { role: 'user', content: 'Hello' } }),
      JSON.stringify({ type: 'last-prompt', sessionId: 'session-1', lastPrompt: 'Hello' }),
      JSON.stringify({ type: 'assistant', sessionId: 'session-1', uuid: 'u-2', message: { role: 'assistant', content: 'Hi' } }),
    ],
  },
  {
    runtime: 'codex',
    adapter: codexAdapter,
    stream: StreamKey.parse('codex:thread-1:thread-1'),
    path: (sandbox: Sandbox): string => join(sandbox.codex, 'sessions', '2026', '10', '01', 'rollout-thread-1.jsonl'),
    lines: [
      JSON.stringify({ timestamp: '2026-10-01T10:00:00Z', ordinal: 0, type: 'session_meta', payload: { id: 'thread-1' } }),
      JSON.stringify({ timestamp: '2026-10-01T10:00:01Z', ordinal: 1, type: 'event_msg', payload: { type: 'task_started' } }),
      JSON.stringify({ timestamp: '2026-10-01T10:00:02Z', ordinal: 2, type: 'event_msg', payload: { type: 'task_complete' } }),
    ],
  },
] as const

export const writeSession = async (path: string, lines: readonly string[]): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${lines.join('\n')}\n`)
}
