#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCli } from '@aang/cli'
import { runDaemon } from '@aang/daemon'

const entry = fileURLToPath(import.meta.url)
const staticRoot = dirname(fileURLToPath(import.meta.resolve('#web')))
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
  readonly version: string
}

process.exitCode = await runCli(process.argv.slice(2), {
  command: process.execPath,
  args: [entry],
  run: (options) => runDaemon({ ...options, staticRoot, version }),
})
