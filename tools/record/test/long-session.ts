import { appendFile, mkdir, open, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout } from 'node:timers/promises'

const [written = '0', delivered = '0', appended = '0'] = process.argv.slice(2)
const claude = process.env['CLAUDE_CONFIG_DIR'] ?? ''
const spool = process.env['AANG_RECORD_SPOOL'] ?? ''
const transcript = join(claude, 'projects', 'record-project', 'long.jsonl')
const line = (index: number): string =>
  `${JSON.stringify({ type: 'assistant', sessionId: 'session-long', uuid: `event-long-${String(index)}`, index, written_at: Date.now(), text: 'x'.repeat(2_000) })}\n`
await mkdir(dirname(transcript), { recursive: true })
await writeFile(transcript, Array.from({ length: Number(written) }, (_, index) => line(index)).join(''))
for (let index = 0; index < Number(delivered); index += 1) {
  const name = `long-${String(index).padStart(6, '0')}`
  const payload = JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'session-long', tool_use_id: `tool-long-${String(index)}`, tool_name: 'Bash' })
  await writeFile(join(spool, 'tmp', name), `aang-spool/1 claude plugin\nCLAUDE_PROJECT_DIR=${process.cwd()}\0\0${payload}`)
  await rename(join(spool, 'tmp', name), join(spool, 'new', name))
}
for (let index = Number(written); index < Number(written) + Number(appended); index += 1) {
  await appendFile(transcript, line(index))
  await setTimeout(40)
}
const rewritten = join(claude, 'projects', 'record-project', 'rewritten.jsonl')
const entry = (name: string): string => `${JSON.stringify({ type: 'user', sessionId: 'session-long', uuid: `event-${name}` })}\n`
await writeFile(rewritten, [entry('first'), entry('second'), entry('third')].join(''))
await setTimeout(200)
await writeFile(rewritten, [entry('shorter')].join(''))
await setTimeout(200)
await writeFile(rewritten, [entry('replaced')].join(''))
await setTimeout(200)
const large = join(claude, 'projects', 'record-project', 'large.jsonl')
const record = (name: string): string =>
  `${JSON.stringify({ type: 'user', sessionId: 'session-long', uuid: `event-${name}`, written_at: Date.now(), text: 'x'.repeat(2_000) })}\n`
await writeFile(large, [record('start'), record('middle'), record('end')].join(''))
await setTimeout(200)
const handle = await open(large, 'r+')
await handle.write(record('begin'), 0)
await handle.close()
await setTimeout(200)
const [, ...rest] = (await readFile(large, 'utf8')).split(/(?<=\n)/)
await writeFile(`${large}.next`, [record('again'), ...rest, record('extra')].join(''))
await rename(`${large}.next`, large)
await setTimeout(200)
await appendFile(large, record('after'))
await setTimeout(200)
