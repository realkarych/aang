import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const repository = fileURLToPath(new URL('../../../../', import.meta.url))
const { installFakeClaude, installFakeCodex } = await import(join(repository, 'packages/testkit/dist/index.js'))

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { runtime: { type: 'string', default: 'claude' }, before: { type: 'string', default: '12' }, 'limit-seconds': { type: 'string', default: '300' }, failures: { type: 'string', default: '5' } },
})
const [scenario, directory] = positionals
if (directory === undefined || !['limit', 'failures'].includes(scenario ?? '')) {
  throw new Error('Usage: fake-observer.mjs limit|failures <directory> [--runtime claude|codex] [--before N] [--limit-seconds S] [--failures N]')
}
const map = { kind: 'script', script: 'map' }
const before = Array.from({ length: Number(values.before) }, () => map)
const outage = scenario === 'limit'
  ? [{ kind: 'limit', resetsAt: Math.floor(Date.now() / 1000) + Number(values['limit-seconds']) }]
  : Array.from({ length: Number(values.failures) }, () => ({ kind: 'network' }))
const fake = (values.runtime === 'codex' ? installFakeCodex : installFakeClaude)(directory, {
  replies: [...before, ...outage, map],
  chatReplies: [{ kind: 'script', script: 'chat-answer' }],
})
process.stdout.write(`${fake.path}\n`)
