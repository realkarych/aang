import { writeSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { createClaudeLauncher, createObserverScheduler } from '@aang/observer'
import { openStore } from '@aang/store'

const [, , home, root, at, command, ...args] = process.argv
if (home === undefined || root === undefined || at === undefined || command === undefined) {
  throw new Error('usage: daemon-process <home> <root> <now> <command> [args...]')
}
const user = join(root, 'Имя Фамилия')
const claude = createClaudeLauncher({
  temporaryDirectory: root,
  environment: { ...process.env, HOME: user, USERPROFILE: user },
  windowsLauncher: resolve('packages/hook/bin/aang-hook.exe'),
  timeoutMs: 20_000,
  cli: { command, args },
  model: 'claude-opus-5-5',
  builtins: { mcpServers: [], skills: [], plugins: ['cc-plugin-agents-md', 'cc-plugin-plugin-authoring'] },
})
const now = Number(at)
const scheduler = createObserverScheduler({
  store: openStore({ home }),
  backends: { claude },
  clock: { now: () => now, schedule: () => () => undefined },
})
void scheduler.failure.then((error: unknown) => {
  process.stderr.write(String(error))
  process.exit(1)
})
scheduler.wake()
while (scheduler.backendState('claude').state === 'ok') {
  await setTimeout(20)
}
writeSync(1, 'ready\n')
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
