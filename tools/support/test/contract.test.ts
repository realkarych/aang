import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  checkRecording,
  type ContractRunOptions,
  matrixOf,
  matrixPath,
  readMatrix,
  type RecordingCheck,
  runRecordings,
  snapshotFile,
  staleSnapshots,
} from '../dist/index.js'
import { hookBinary } from './fixtures.js'

const options: ContractRunOptions = {
  sessions: resolve('fixtures/sessions'),
  support: resolve('support'),
  hookBinary,
}

const recordings = await runRecordings(options.sessions)

const checks = new Map<string, RecordingCheck>()

if (recordings.length > 0) {
  describe.concurrent('the contract run replays every reference session through the adapters and the engine', () => {
    test.for(recordings.map((recording) => [recording.name, recording] as const))('%s', async ([, recording], context) => {
      const check = await checkRecording(recording, options)
      checks.set(recording.name, check)

      context.expect(check.violations).toEqual([])
      context.expect(check.expected, `${snapshotFile(options.support, recording)} is missing`).not.toBeNull()
      context.expect(JSON.parse(check.snapshot) as unknown).toEqual(JSON.parse(check.expected ?? 'null') as unknown)
    })
  })
}

describe('the support matrix', () => {
  test('support/matrix.json is the matrix of this contract run', async () => {
    expect(checks.size).toBe(recordings.length)

    const generated = matrixOf(
      recordings.flatMap((recording) => checks.get(recording.name) ?? []),
      await readMatrix(options.support),
    )

    expect(generated).toBe(await readFile(matrixPath(options.support), 'utf8'))
  })

  test('every stored snapshot belongs to a recording of the run', async () => {
    expect(await staleSnapshots(options.support, recordings)).toEqual([])
  })
})
