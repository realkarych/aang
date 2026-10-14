import { fileURLToPath } from 'node:url'
import { runDaemon } from '@catacomb/daemon'

const [catacombHome, homedir] = process.argv.slice(2)
if (catacombHome === undefined || homedir === undefined) {
  throw new Error('usage: host.ts <CATACOMB_HOME> <HOME>')
}

await runDaemon({
  version: '0.0.0-test',
  environment: { env: { CATACOMB_HOME: catacombHome }, homedir },
  bind: null,
  staticRoot: null,
  supportMatrix: fileURLToPath(new URL('../../../support/matrix.json', import.meta.url)),
  placement: 'local',
  signal: new AbortController().signal,
  onReady: (ready) => {
    process.stdout.write(`${JSON.stringify(ready)}\n`)
  },
})
