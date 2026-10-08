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
      const counted = new Map()
      for (const change of candidate.changes) counted.set(change, (counted.get(change) ?? 0) + 1)
      const changes = [...counted].map(([change, count]) => (count > 1 ? `${change} ×${String(count)}` : change)).join('; ')
      process.stdout.write(`  [${String(index)}] +${(candidate.after_ms / 1000).toFixed(1)} s ${candidate.author} v${String(candidate.version)}: ${changes.slice(0, Number(values.width))}\n`)
    })
  }
} else {
  const verdicts = JSON.parse(await readFile(values.verdicts, 'utf8'))
  const unknown = Object.keys(verdicts).filter((key) => !annotations.events.some((event) => keyOf(event) === key))
  if (unknown.length > 0) throw new Error(`verdicts for unknown events: ${unknown.join(', ')}`)
  const events = annotations.events.map((event) => {
    const key = keyOf(event)
    const verdict = verdicts[key]
    if (verdict === undefined) throw new Error(`${key} has no verdict`)
    const { candidate: choice, held_before: held = false, mismatch = false, reason } = verdict
    if (typeof reason !== 'string' || reason.trim() === '') throw new Error(`${key} has no reason for its verdict`)
    if (held && mismatch) throw new Error(`${key} cannot both hold before its event and mismatch its recording`)
    if (choice === null) return { ...event, verdict: held ? { held_before: true } : mismatch ? { mismatch: true } : { met: false } }
    if (held || mismatch) throw new Error(`${key} is a markup defect and names a candidate`)
    const candidate = event.candidates[choice]
    if (candidate === undefined) throw new Error(`${key} has no candidate ${String(choice)}`)
    return { ...event, verdict: { met: true, run: candidate.run, version: candidate.version } }
  })
  await writeFile(path, `${JSON.stringify({ ...annotations, events }, null, 2)}\n`)
  process.stdout.write(`${String(events.length)} events have a verdict\n`)
}
