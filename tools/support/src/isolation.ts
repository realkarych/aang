import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  defaultConfig,
  type ObserverIsolationResult,
  type OperatingSystem,
  type SupportKey,
  type SupportMatrix,
  supportKeyText,
} from '@aang/contract'
import { readSupportMatrix } from '@aang/contract/support-file'
import { createCodexBackend } from '@aang/observer'
import { importObservers, serializeMatrix, withObserver } from './matrix.js'
import { matrixPath, readMatrix } from './run.js'
import { readVerification, type SupportVerification } from './verification.js'

export interface IsolationCheck {
  readonly key: SupportKey
  readonly observer: ObserverIsolationResult
  readonly reason: string | null
}

export interface CodexIsolationOptions {
  readonly cli: string
  readonly windowsLauncher: string
}

const isolationOs = (): OperatingSystem =>
  process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux'

export const checkCodexIsolation = async (options: CodexIsolationOptions): Promise<IsolationCheck> => {
  const temporaryDirectory = await realpath(await mkdtemp(join(tmpdir(), 'aang-isolation-')))
  try {
    const backend = createCodexBackend({
      cli: options.cli,
      model: defaultConfig().observer.models.codex,
      environment: process.env,
      windowsLauncher: options.windowsLauncher,
      temporaryDirectory,
      admissionStatusPath: join(temporaryDirectory, 'codex-observer.json'),
    })
    const admission = await backend.admit()
    const { state } = backend.status()
    const violated = state.state === 'disabled' && state.reason === 'isolation'
    if (admission.version === null || (!admission.admitted && !violated)) {
      throw new Error(`the Codex admission did not complete: ${admission.reason ?? state.state}`)
    }
    return {
      key: { runtime: 'codex', surface: 'codex_exec', os: isolationOs(), placement: 'local', engine_version: admission.version },
      observer: {
        admission: admission.admitted ? 'passed' : 'failed',
        cross_session_inbound: 'not_run',
        builtins: { mcp_servers: [], plugins: [], skills: [] },
      },
      reason: admission.reason,
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

const rewriteMatrix = async (
  support: string,
  change: (matrix: SupportMatrix | null, verification: SupportVerification) => SupportMatrix,
): Promise<void> => {
  const matrix = change(await readMatrix(support), await readVerification(support))
  await mkdir(support, { recursive: true })
  await writeFile(matrixPath(support), serializeMatrix(matrix))
}

export const recordIsolation = (support: string, check: IsolationCheck): Promise<void> =>
  rewriteMatrix(support, (matrix, verification) => withObserver(matrix, check.key, check.observer, verification))

export const importIsolation = async (support: string, files: readonly string[]): Promise<void> => {
  const sources = await Promise.all(files.map((file) => readSupportMatrix(file)))
  await rewriteMatrix(support, (matrix, verification) => importObservers(matrix, sources, verification))
}

export const isolationSummary = ({ key, observer, reason }: IsolationCheck): string =>
  `${supportKeyText(key)}: admission ${observer.admission}${reason === null ? '' : ` (${reason})`}`
