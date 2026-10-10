#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCli } from '@aang/cli'
import { findHookBinary, missingHookBinary } from './hook-binary.js'

const entry = fileURLToPath(import.meta.url)
const staticRoot = dirname(fileURLToPath(import.meta.resolve('#web')))
const packagedSupportMatrix = new URL('../support/matrix.json', import.meta.url)
const supportMatrix = fileURLToPath(
  existsSync(packagedSupportMatrix) ? packagedSupportMatrix : new URL('../../../support/matrix.json', import.meta.url),
)
const placement = existsSync('/.dockerenv') ? 'docker' : 'local'
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
    run: async (options) => {
      const { runDaemon } = await import('@aang/daemon')
      return runDaemon({ ...options, staticRoot, supportMatrix, placement, version })
    },
  },
  locateHookBinary,
})
