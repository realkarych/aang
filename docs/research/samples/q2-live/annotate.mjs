import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

const { values, positionals } = parseArgs({ allowPositionals: true, options: { verdicts: { type: 'string' }, width: { type: 'string', default: '160' } } })
const [directory] = positionals
if (directory === undefined) throw new Error('Usage: annotate.mjs <measurement directory> [--verdicts <verdicts.json>]')
const path = join(directory, 'annotations.json')
const annotations = JSON.parse(await readFile(path, 'utf8'))
const keyOf = ({ recording, label }) => `${recording.split('/').at(-1)}:${label}`

if (values.verdicts === undefined) {
  for (const event of annotations.events) {
    process.stdout.write(`\n## ${keyOf(event)}\n${event.description}\n`)
    event.candidates.forEach((candidate, index) => {
      const changes = candidate.changes.join('; ')
      process.stdout.write(`  [${String(index)}] +${(candidate.after_ms / 1000).toFixed(1)} s ${candidate.author} v${String(candidate.version)}: ${changes.slice(0, Number(values.width))}\n`)
    })
  }
} else {
  const verdicts = JSON.parse(await readFile(values.verdicts, 'utf8'))
  const events = annotations.events.map((event) => {
    const choice = verdicts[keyOf(event)]
    if (choice === undefined) return event
    if (choice === null) return { ...event, verdict: { met: false } }
    const candidate = event.candidates[choice]
    if (candidate === undefined) throw new Error(`${keyOf(event)} has no candidate ${String(choice)}`)
    return { ...event, verdict: { met: true, run: candidate.run, version: candidate.version } }
  })
  const unknown = Object.keys(verdicts).filter((key) => !annotations.events.some((event) => keyOf(event) === key))
  if (unknown.length > 0) throw new Error(`verdicts for unknown events: ${unknown.join(', ')}`)
  await writeFile(path, `${JSON.stringify({ ...annotations, events }, null, 2)}\n`)
  process.stdout.write(`${String(events.filter(({ verdict }) => verdict !== null).length)} of ${String(events.length)} events have a verdict\n`)
}
