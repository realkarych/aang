import { cp, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const [source, target, runtime] = process.argv.slice(2)
if (source === undefined || target === undefined || runtime === undefined) {
  throw new Error('Usage: plan-only.mjs <fixtures> <target> <runtime>')
}
for (const version of await readdir(join(source, runtime))) {
  for (const surface of await readdir(join(source, runtime, version))) {
    for (const os of await readdir(join(source, runtime, version, surface))) {
      for (const scenario of (await readdir(join(source, runtime, version, surface, os))).filter((name) => name.startsWith('workload-'))) {
        const relative = join(runtime, version, surface, os, scenario)
        await cp(join(source, relative), join(target, relative), { recursive: true })
        const manifestPath = join(target, relative, 'manifest.json')
        const playbackPath = join(target, relative, 'playback.json')
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
        const playback = JSON.parse(await readFile(playbackPath, 'utf8'))
        const ready = manifest.control_events.find(({ label }) => label === 'plan-ready')
        if (ready === undefined) throw new Error(`${relative} has no plan-ready event`)
        manifest.control_events = manifest.control_events.filter(({ step }) => step <= ready.step)
        playback.steps = playback.steps.slice(0, ready.step + 1)
        await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
        await writeFile(playbackPath, `${JSON.stringify(playback, null, 2)}\n`)
        const span = playback.steps.at(-1).at - playback.steps[0].at
        process.stdout.write(`${relative}: ${String(playback.steps.length)} steps, ${(span / 1000).toFixed(1)} s, events ${manifest.control_events.map(({ label }) => label).join(', ')}\n`)
      }
    }
  }
}
