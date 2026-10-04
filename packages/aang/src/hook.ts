#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { findHookBinary, missingHookBinary } from './hook-binary.js'

const run = (): number => {
  const binary = findHookBinary()
  if (binary === undefined) {
    process.stderr.write(`aang-hook: ${missingHookBinary}\n`)
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
