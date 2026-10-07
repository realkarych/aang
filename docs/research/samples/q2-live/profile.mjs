import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    runtime: { type: 'string' },
    fixtures: { type: 'string' },
    surface: { type: 'string' },
    cli: { type: 'string' },
    out: { type: 'string' },
    'second-lane-ms': { type: 'string', default: '300000' },
    'gap-ms': { type: 'string', default: '90000' },
    'window-ms': { type: 'string', default: '120000' },
  },
})
const { runtime, fixtures, surface, out } = values
if (runtime === undefined || fixtures === undefined || surface === undefined || out === undefined) {
  throw new Error('Usage: profile.mjs --runtime claude|codex --fixtures <dir> --surface <surface> [--cli <observer CLI>] --out <profile.json>')
}
const lanes = [['ledger', 'kvstore'], ['logstats', 'mdlinks']]
const questions = [
  [0.3, 'Что сейчас делает прогон и что осталось сделать по плану?'],
  [0.6, 'Какие тесты падали за прогон и чем это закончилось?'],
  [0.95, 'Нужно ли сейчас моё вмешательство? Если да, то где.'],
]
const versions = await readdir(join(fixtures, runtime))
const recordingOf = async (task) => {
  for (const version of versions) {
    const recording = `${runtime}/${version}/${surface}/macos/workload-${task}`
    const found = await readFile(join(fixtures, ...recording.split('/'), 'playback.json'), 'utf8').then(() => true, () => false)
    if (found) return recording
  }
  throw new Error(`no recording of ${task} under ${join(fixtures, runtime)}`)
}
const durationOf = async (recording) => {
  const { steps } = JSON.parse(await readFile(join(fixtures, ...recording.split('/'), 'playback.json'), 'utf8'))
  return steps.at(-1).at - steps[0].at
}
const runs = []
for (const [lane, tasks] of lanes.entries()) {
  let start = lane === 0 ? 0 : Number(values['second-lane-ms'])
  for (const task of tasks) {
    const recording = await recordingOf(task)
    const duration = await durationOf(recording)
    runs.push({
      recording,
      start_ms: start,
      chat: questions.map(([share, question]) => ({ after_ms: Math.round(duration * share), question })),
    })
    start += duration + Number(values['gap-ms'])
  }
}
const profile = {
  format: 'aang-freshness-profile/1',
  name: `${runtime}-workload`,
  time_scale: 1,
  window_ms: Number(values['window-ms']),
  observer: { [runtime]: { cli: values.cli ?? null, model: null, effort: null, target_p95_ms: runtime === 'claude' ? 30_000 : 40_000 } },
  runs: runs.toSorted((left, right) => left.start_ms - right.start_ms),
}
await writeFile(out, `${JSON.stringify(profile, null, 2)}\n`)
