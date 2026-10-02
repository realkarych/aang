import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test } from 'vitest'
import { run } from '../dist/process.js'

test('the runtime check fails when external CLIs report versions but every session fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aang-runtime-failure-'))
  try {
    const cli = join(directory, process.platform === 'win32' ? 'failed-cli.exe' : 'failed-cli')
    execFileSync('go', ['build', '-o', cli, resolve('tools/runtime-check/test/fixtures/failing-cli.go')])
    const out = join(directory, 'out')
    const result = await run(process.execPath, [
      resolve('tools/runtime-check/dist/main.js'), '--claude', cli, '--codex', cli,
      '--out', out, '--work', join(directory, 'work'),
    ], {
      env: { ...process.env, HOME: directory, USERPROFILE: directory, PATH: '', Path: '', GITHUB_STEP_SUMMARY: undefined },
      timeoutMs: 180_000,
    })
    const report = JSON.parse(await readFile(join(out, 'report.json'), 'utf8')) as {
      failedSections: string[]
      checks: Record<string, { status: string }>
    }
    expect(result.timedOut, `${result.stdout}\n${result.stderr}\n${JSON.stringify(report)}`).toBe(false)
    expect(result.status, result.stderr).toBe(1)
    expect(report.checks['default roots']?.status).toBe('skipped')
    expect(report.failedSections).toEqual(expect.arrayContaining([
      'claude hook delivery',
      'claude hook launchers',
      'codex hook command forms',
      'codex hook exit and timeout',
      'collector and adapters on real files',
      'hook latency by launcher',
      'claude series with and without hooks',
      'codex series with and without hooks',
      'observer admission',
    ]))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 240_000)
