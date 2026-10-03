#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const platform = `${process.platform}-${process.arch}`
const missingCodes: readonly unknown[] = ['ERR_MODULE_NOT_FOUND', 'ERR_PACKAGE_IMPORT_NOT_DEFINED']

const locateBinary = (): string | undefined => {
  try {
    return fileURLToPath(import.meta.resolve(`#aang-hook-${platform}`))
  } catch (error) {
    if (error instanceof Error && 'code' in error && missingCodes.includes(error.code)) {
      return undefined
    }
    throw error
  }
}

const run = (): number => {
  const binary = locateBinary()
  if (binary === undefined) {
    process.stderr.write(
      `aang-hook: no aang-hook binary is installed for ${platform}; aang ships it as the optional dependency aang-hook-${platform} for darwin, linux and win32 on x64 and arm64, so reinstall aang without omitting optional dependencies\n`,
    )
    return 1
  }
  const { status, error } = spawnSync(binary, process.argv.slice(2), { stdio: 'inherit', windowsHide: true })
  if (error !== undefined) {
    process.stderr.write(`aang-hook: ${error.message}\n`)
    return 1
  }
  return status ?? 1
}

process.exitCode = run()
