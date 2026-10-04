#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCli } from '@aang/cli'
import { runDaemon } from '@aang/daemon'
import { findHookBinary, missingHookBinary } from './hook-binary.js'

const entry = fileURLToPath(import.meta.url)
const staticRoot = dirname(fileURLToPath(import.meta.resolve('#web')))
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
  readonly version: string
}

const locateHookBinary = (): string => {
  const binary = findHookBinary()
  if (binary === undefined) {
    throw new Error(missingHookBinary)
  }
  return binary
}

process.exitCode = await runCli(process.argv.slice(2), {
  daemon: {
    command: process.execPath,
    args: [entry],
    run: (options) => runDaemon({ ...options, staticRoot, version }),
  },
  locateHookBinary,
})
