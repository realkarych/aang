import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { lineStarts } from './position.js'
import { comments, failure, type ScanResult } from './scan.js'

interface BuildkitReport {
  readonly comments: readonly number[]
  readonly error?: { readonly line: number; readonly message: string }
}

const buildkitScanner = fileURLToPath(
  new URL(`../dockerfile-comments/bin/dockerfile-comments${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url),
)

const buildkitReport = (text: string): BuildkitReport => {
  const run = spawnSync(buildkitScanner, { input: text, encoding: 'utf8' })
  if (run.error !== undefined) {
    throw run.error
  }
  if (run.status !== 0) {
    throw new Error(`${buildkitScanner} exited with ${String(run.status ?? run.signal)}: ${run.stderr.trim()}`)
  }
  return JSON.parse(run.stdout) as BuildkitReport
}

export const scanDockerfile = (text: string): ScanResult => {
  const report = buildkitReport(text)
  const starts = lineStarts(text)
  const lineOffset = (line: number): number => starts[line - 1] ?? text.length
  return report.error === undefined
    ? comments(report.comments.map((line) => text.indexOf('#', lineOffset(line))))
    : failure(lineOffset(report.error.line), report.error.message)
}

export const scanDockerignore = (text: string): ScanResult =>
  comments(lineStarts(text).filter((offset) => text.startsWith('#', offset)))
