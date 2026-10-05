import { fileURLToPath } from 'node:url'
import { runDaemon } from '@aang/daemon'

const [aangHome, homedir] = process.argv.slice(2)
if (aangHome === undefined || homedir === undefined) {
  throw new Error('usage: host.ts <AANG_HOME> <HOME>')
}

await runDaemon({
  version: '0.0.0-test',
  environment: { env: { AANG_HOME: aangHome }, homedir },
  bind: null,
  staticRoot: null,
  supportMatrix: fileURLToPath(new URL('../../../support/matrix.json', import.meta.url)),
  placement: 'local',
  signal: new AbortController().signal,
  onReady: (ready) => {
    process.stdout.write(`${JSON.stringify(ready)}\n`)
  },
})
