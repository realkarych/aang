#!/usr/bin/env node
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCli } from '@aang/cli'
import { runDaemon } from '@aang/daemon'

const entry = fileURLToPath(import.meta.url)
const staticRoot = dirname(fileURLToPath(import.meta.resolve('#web')))

process.exitCode = await runCli(process.argv.slice(2), {
  command: process.execPath,
  args: [entry],
  run: (options) => runDaemon({ ...options, staticRoot }),
})
