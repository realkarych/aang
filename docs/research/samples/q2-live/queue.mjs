import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

const { values, positionals } = parseArgs({ allowPositionals: true, options: { above: { type: 'string', default: '30' } } })
const [directory] = positionals
if (directory === undefined) throw new Error('Usage: queue.mjs <measurement directory> [--above <facts>]')
const measurement = JSON.parse(await readFile(join(directory, 'measurement.json'), 'utf8'))
const above = Number(values.above)
const recordingOf = new Map(measurement.events.flatMap(({ runs, recording }) => runs.map((run) => [run, recording])))
const runs = [...new Set(measurement.states.map(({ run }) => run))]
const rows = runs.map((run) => {
  const samples = measurement.states.filter((sample) => sample.run === run).toSorted((left, right) => left.at - right.at)
  let queued = 0
  for (const [index, sample] of samples.entries()) {
    const next = samples[index + 1]
    if (next !== undefined && sample.pending_facts > above) queued += next.at - sample.at
  }
  return {
    recording: recordingOf.get(run) ?? run,
    above_s: Math.round(queued / 1000),
    peak: Math.max(0, ...samples.map(({ pending_facts: pending }) => pending)),
  }
})
process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`)
