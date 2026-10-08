import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const repository = fileURLToPath(new URL('../../../../', import.meta.url))
const { openStore } = await import(join(repository, 'packages/store/dist/index.js'))
const { describeChange, emptyModel, versionStates } = await import(join(repository, 'tools/freshness/dist/journal.js'))

const { values, positionals } = parseArgs({ allowPositionals: true, options: { at: { type: 'string' } } })
const [directory, key] = positionals
if (directory === undefined || key === undefined) {
  throw new Error('Usage: state.mjs <measurement directory> <recording name>:<label> [--at <candidate>]')
}
const read = async (name) => JSON.parse(await readFile(join(directory, name), 'utf8'))
const [measurement, annotations] = await Promise.all([read('measurement.json'), read('annotations.json')])
const keyOf = ({ recording, label }) => `${recording.split('/').at(-1)}:${label}`
const event = measurement.events.find((candidate) => keyOf(candidate) === key)
const annotated = annotations.events.find((candidate) => keyOf(candidate) === key)
if (event === undefined || annotated === undefined || event.observed_at === null) throw new Error(`${key} is not an annotated event`)

const results = new Map(measurement.calls.flatMap(({ id, result_version: last }) => (last === null ? [] : [[id, last]])))
const store = openStore({ home: join(directory, 'aang') })
const states = new Map(event.runs.map((run) => [run, versionStates(store, run, results)]))
const start = BigInt(event.observed_at) * 1_000_000n

const counted = (changes) => {
  const counts = new Map()
  for (const change of changes) counts.set(change, (counts.get(change) ?? 0) + 1)
  return [...counts].map(([change, count]) => (count > 1 ? `${change} ×${String(count)}` : change))
}

const render = (model) => {
  const titles = new Map(model.stages.map((stage) => [stage.id, stage.title]))
  const agents = (stage) => new Set(model.links.flatMap((link) => (link.kind === 'participation' && link.stage === stage ? [link.agent] : []))).size
  const stageLine = (stage) => {
    const marks = [
      stage.execution.value.state,
      ...(stage.lifecycle.state === 'active' ? [] : [stage.lifecycle.state]),
      ...(stage.decision.value === 'none' ? [] : [`decision ${stage.decision.value}`]),
      ...(agents(stage.id) === 0 ? [] : [`agents ${String(agents(stage.id))}`]),
    ]
    const parent = stage.parent === null ? '' : ` < ${titles.get(stage.parent) ?? stage.parent}`
    const summary = stage.summary === null ? '' : ` | ${stage.summary}`
    return `  stage [${marks.join(', ')}] ${stage.title}${parent}${summary}`
  }
  return [
    `  brief: ${model.run?.brief?.text ?? '-'}`,
    ...model.stages.map(stageLine),
    ...model.criteria.map(({ status, text, stage }) => `  criterion [${status.value}] ${text}${stage === null ? '' : ` (${titles.get(stage) ?? stage})`}`),
    ...model.attention.map(({ kind, author, resolution, text }) => `  attention [${kind} ${author} ${resolution}] ${text}`),
    ...model.cards.map(({ text }) => `  card ${text}`),
  ].join('\n')
}

const lines = [`## ${key}`, annotated.description]
if (values.at === undefined) {
  for (const [run, versions] of states) {
    const baseline = versions.findLast(({ record }) => record.created_at < start)
    lines.push(`\nrun ${run}, v${String(baseline?.record.version ?? 0)} before the event:`, render(baseline?.model ?? emptyModel))
  }
  lines.push('\ncandidates:')
  annotated.candidates.forEach((candidate, index) => {
    const changes = states.get(candidate.run)?.find(({ record }) => record.version === candidate.version)?.changes ?? []
    lines.push(`[${String(index)}] +${(candidate.after_ms / 1000).toFixed(1)} s ${candidate.author} v${String(candidate.version)}`, ...counted(changes.map(describeChange)).map((change) => `    ${change}`))
  })
} else {
  const candidate = annotated.candidates[Number(values.at)]
  if (candidate === undefined) throw new Error(`${key} has no candidate ${values.at}`)
  const state = states.get(candidate.run)?.find(({ record }) => record.version === candidate.version)
  lines.push(`\n[${values.at}] +${(candidate.after_ms / 1000).toFixed(1)} s ${candidate.author} run ${candidate.run} v${String(candidate.version)}:`, render(state.model))
}
process.stdout.write(`${lines.join('\n')}\n`)
store.close()
