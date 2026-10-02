import { runDaemon } from '@aang/daemon'

const [aangHome, homedir] = process.argv.slice(2)
if (aangHome === undefined || homedir === undefined) {
  throw new Error('usage: host.ts <AANG_HOME> <HOME>')
}

await runDaemon({
  environment: { env: { AANG_HOME: aangHome }, homedir },
  bind: null,
  staticRoot: null,
  signal: new AbortController().signal,
  onReady: (ready) => {
    process.stdout.write(`${JSON.stringify(ready)}\n`)
  },
})
