import { readFile, rename, writeFile } from 'node:fs/promises'
import { setTimeout } from 'node:timers/promises'

const [specPath, resultPath, controlPath] = process.argv.slice(2)
const spec = JSON.parse(await readFile(specPath, 'utf8'))
const publish = async (snapshot) => {
  await writeFile(`${resultPath}.next`, JSON.stringify(snapshot))
  await rename(`${resultPath}.next`, resultPath)
}
const acknowledged = async () => JSON.parse(await readFile(controlPath, 'utf8').catch(() => 'null'))
await publish(spec.first)
await setTimeout(150)
if (await acknowledged() !== null) throw new Error('An incomplete trace was acknowledged')
await publish(spec.next)
const deadline = Date.now() + 750
let ack = null
while (Date.now() < deadline && ack === null) {
  ack = await acknowledged()
  await setTimeout(10)
}
const final = { ...spec.next, traceVersion: 3, traceState: ack === null ? 'timedOut' : 'complete',
  traceError: ack === null ? 'Process trace remained incomplete at the deadline' : null }
if (ack !== null && ack.traceVersion !== spec.next.traceVersion) throw new Error('An obsolete snapshot was acknowledged')
if (spec.finalEvent !== undefined) final.started = [...final.started, spec.finalEvent]
await publish(final)
