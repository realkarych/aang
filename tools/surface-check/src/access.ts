import { signIn } from './aang.js'

export type AccessResult = 'passed' | 'failed' | 'not_run'

export interface AccessReport {
  readonly result: AccessResult
  readonly origin: string | null
  readonly runs: number | null
  readonly write: number | null
  readonly expected_write: number
  readonly error: string | null
}

export const accessNotRun = (expectedWrite = 200): AccessReport => ({
  result: 'not_run',
  origin: null,
  runs: null,
  write: null,
  expected_write: expectedWrite,
  error: null,
})

export const checkAccess = async (link: URL, origin: string, expectedWrite = 200): Promise<AccessReport> => {
  let runs: number | null = null
  let write: number | null = null
  const finish = (result: AccessResult, error: string | null): AccessReport => ({
    result,
    origin,
    runs,
    write,
    expected_write: expectedWrite,
    error,
  })
  try {
    const api = await signIn(link, origin)
    const listed = await api.runs()
    runs = listed.length
    const [first] = listed
    if (first === undefined) {
      return finish('failed', 'the daemon lists no runs through this origin')
    }
    write = await api.markViewed(first)
    return write === expectedWrite
      ? finish('passed', null)
      : finish('failed', `marking the run viewed answered ${String(write)}, expected ${String(expectedWrite)}`)
  } catch (error) {
    return finish('failed', error instanceof Error ? error.message : String(error))
  }
}
