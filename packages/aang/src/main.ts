#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCli } from '@aang/cli'
import { runDaemon } from '@aang/daemon'

const entry = fileURLToPath(import.meta.url)
const staticRoot = dirname(fileURLToPath(import.meta.resolve('@aang/web')))
const supportMatrix = fileURLToPath(new URL('../../../support/matrix.json', import.meta.url))
const placement = existsSync('/.dockerenv') ? 'docker' : 'local'
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
  readonly version: string
}

process.exitCode = await runCli(process.argv.slice(2), {
  command: process.execPath,
  args: [entry],
  run: (options) => runDaemon({ ...options, staticRoot, supportMatrix, placement, version }),
})
