import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import type { Runtime, SupportMatrix } from '@aang/contract'
import { readSupportMatrix } from '@aang/contract/support-file'
import { type RecordingManifest, verifyRecording } from '@aang/record'
import { loadManifest } from '@aang/testkit'
import { isMissing, readOptional } from './files.js'
import { invariantViolations } from './invariants.js'
import { generateMatrix, type RecordingOutcome, serializeMatrix } from './matrix.js'
import { playRecording, removeRoots, restartLabel } from './play.js'
import { findRecordings, type Recording } from './recordings.js'
import { takeSnapshot } from './snapshot.js'
import { readVerification, type SupportVerification } from './verification.js'

export interface ContractRunOptions {
  readonly sessions: string
  readonly support: string
  readonly hookBinary: string
}

export interface RecordingCheck {
  readonly recording: Recording
  readonly snapshot: string
  readonly expected: string | null
  readonly violations: readonly string[]
  readonly restarts: number
}

export interface ContractRun {
  readonly checks: readonly RecordingCheck[]
  readonly staleSnapshots: readonly string[]
  readonly matrix: string
  readonly expectedMatrix: string | null
}

export const pendingScenarios: Readonly<Record<Runtime, readonly string[]>> = {
  claude: [],
  codex: [],
}

export const inContractRun = ({ runtime, scenario }: Pick<RecordingManifest, 'runtime' | 'scenario'>): boolean =>
  !pendingScenarios[runtime].includes(scenario)

const reconnectScenario = 'reconnect'

export const notRestarted = `the recording has no ${restartLabel} step, so the daemon is never restarted`

const snapshotsDirectory = 'contract'
const matrixFile = 'matrix.json'

export const snapshotFile = (support: string, recording: Recording): string =>
  `${join(support, snapshotsDirectory, ...recording.name.split('/'))}.json`

export const matrixPath = (support: string): string => join(support, matrixFile)

export const runRecordings = async (sessions: string): Promise<Recording[]> =>
  (await findRecordings(sessions)).filter(({ manifest }) => inContractRun(manifest))

export const passed = (check: RecordingCheck): boolean => check.violations.length === 0 && check.snapshot === check.expected

export const checkRecording = async (recording: Recording, options: ContractRunOptions): Promise<RecordingCheck> => {
  await verifyRecording(recording.directory)
  const manifest = await loadManifest(join(recording.directory, 'playback.json'))
  const { store, roots, restarts, recordedPids } = await playRecording(manifest, { hookBinary: options.hookBinary })
  try {
    return {
      recording,
      snapshot: `${JSON.stringify(takeSnapshot(store, roots.base, recordedPids), null, 2)}\n`,
      expected: await readOptional(snapshotFile(options.support, recording)),
      violations: [...(recording.manifest.scenario === reconnectScenario && restarts === 0 ? [notRestarted] : []), ...invariantViolations(store)],
      restarts,
    }
  } finally {
    store.close()
    await removeRoots(roots)
  }
}

const storedSnapshots = async (support: string): Promise<string[]> => {
  const directory = join(support, snapshotsDirectory)
  try {
    return (await readdir(directory, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name))
      .sort()
  } catch (error) {
    if (isMissing(error)) {
      return []
    }
    throw error
  }
}

export const staleSnapshots = async (support: string, recordings: readonly Recording[]): Promise<string[]> => {
  const expected = new Set(recordings.map((recording) => snapshotFile(support, recording)))
  return (await storedSnapshots(support)).filter((path) => !expected.has(path))
}

export const readMatrix = async (support: string): Promise<SupportMatrix | null> =>
  (await readOptional(matrixPath(support))) === null ? null : readSupportMatrix(matrixPath(support))

export const matrixOf = (checks: readonly RecordingCheck[], previous: SupportMatrix | null, verification: SupportVerification): string => {
  const outcomes: RecordingOutcome[] = checks.map((check) => ({ manifest: check.recording.manifest, passed: passed(check) }))
  return serializeMatrix(generateMatrix({ outcomes, previous, verification, contractScenarios: inContractRun }))
}

export const contractRun = async (options: ContractRunOptions): Promise<ContractRun> => {
  const verification = await readVerification(options.support)
  const recordings = await runRecordings(options.sessions)
  const checks: RecordingCheck[] = []
  for (const recording of recordings) {
    checks.push(await checkRecording(recording, options))
  }
  return {
    checks,
    staleSnapshots: await staleSnapshots(options.support, recordings),
    matrix: matrixOf(checks, await readMatrix(options.support), verification),
    expectedMatrix: await readOptional(matrixPath(options.support)),
  }
}

export const runProblems = (run: ContractRun, support: string): string[] => [
  ...run.checks.flatMap((check) => [
    ...(check.expected === null ? [`${check.recording.name}: no stored snapshot`] : []),
    ...(check.expected !== null && check.expected !== check.snapshot ? [`${check.recording.name}: the snapshot differs`] : []),
    ...check.violations.map((violation) => `${check.recording.name}: ${violation}`),
  ]),
  ...run.staleSnapshots.map((path) => `${relative(support, path)}: no recording in the contract run`),
  ...(run.matrix === run.expectedMatrix ? [] : [`${matrixFile} does not match the contract run`]),
]

export const updateSupport = async (run: ContractRun, support: string): Promise<void> => {
  const broken = run.checks.filter((check) => check.violations.length > 0)
  if (broken.length > 0) {
    throw new Error(`invariants are violated, nothing is written:\n${broken.flatMap((check) => check.violations.map((violation) => `${check.recording.name}: ${violation}`)).join('\n')}`)
  }
  for (const check of run.checks) {
    const path = snapshotFile(support, check.recording)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, check.snapshot)
  }
  await Promise.all(run.staleSnapshots.map((path) => rm(path)))
  const accepted = run.checks.map((check) => ({ ...check, expected: check.snapshot }))
  await mkdir(support, { recursive: true })
  await writeFile(matrixPath(support), matrixOf(accepted, await readMatrix(support), await readVerification(support)))
}
