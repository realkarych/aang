#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCli } from '@aang/cli'
import { runDaemon } from '@aang/daemon'

const entry = fileURLToPath(import.meta.url)
const staticRoot = dirname(fileURLToPath(import.meta.resolve('@aang/web')))
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
  readonly version: string
}
const platform = `${process.platform}-${process.arch}`
const missingCodes: readonly unknown[] = ['ERR_MODULE_NOT_FOUND', 'ERR_PACKAGE_IMPORT_NOT_DEFINED']

const locateHookBinary = (): string => {
  try {
    return fileURLToPath(import.meta.resolve(`#aang-hook-${platform}`))
  } catch (error) {
    if (error instanceof Error && 'code' in error && missingCodes.includes(error.code)) {
      throw new Error(
        `no aang-hook binary is installed for ${platform}; reinstall aang without omitting its optional dependencies`,
        { cause: error },
      )
    }
    throw error
  }
}

process.exitCode = await runCli(process.argv.slice(2), {
  daemon: {
    command: process.execPath,
    args: [entry],
    run: (options) => runDaemon({ ...options, staticRoot, version }),
  },
  locateHookBinary,
})
