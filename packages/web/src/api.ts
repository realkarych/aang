import {
  ApiError,
  endpoints,
  type Fact,
  type FactId,
  type RunId,
  type RunSnapshot,
  type RunsResponse,
  type StatusResponse,
} from '@aang/contract'

export class SignedOut extends Error {
  override readonly name = 'SignedOut'
}

export class Unreachable extends Error {
  override readonly name = 'Unreachable'
}

export class NotFound extends Error {
  override readonly name = 'NotFound'
}

export class RequestFailed extends Error {
  override readonly name = 'RequestFailed'
}

interface Decoder<T> {
  readonly parse: (value: unknown) => T
}

const failureMessage = async (response: Response): Promise<string> => {
  const body: unknown = await response.json().catch(() => null)
  const parsed = ApiError.safeParse(body)
  return parsed.success ? parsed.data.error.message : `${String(response.status)} ${response.statusText}`
}

export const ensureSignedIn = (response: Response): Response => {
  if (response.status === 401) {
    throw new SignedOut('the aang session cookie is missing or no longer valid')
  }
  return response
}

const read = async <T>(path: string, decoder: Decoder<T>, signal: AbortSignal): Promise<T> => {
  let response: Response
  try {
    response = await fetch(path, { headers: { accept: 'application/json' }, cache: 'no-store', signal })
  } catch (error) {
    if (signal.aborted) {
      throw error
    }
    throw new Unreachable(error instanceof Error ? error.message : String(error))
  }
  ensureSignedIn(response)
  if (response.status === 404) {
    throw new NotFound(await failureMessage(response))
  }
  if (!response.ok) {
    throw new RequestFailed(await failureMessage(response))
  }
  return decoder.parse(await response.json())
}

const withRun = (path: string, run: RunId): string => path.replace(':run', encodeURIComponent(run))

export const readStatus = (signal: AbortSignal): Promise<StatusResponse> =>
  read(endpoints.status.path, endpoints.status.response, signal)

export const readRuns = (signal: AbortSignal): Promise<RunsResponse> =>
  read(endpoints.runs.path, endpoints.runs.response, signal)

export const readRun = (run: RunId, signal: AbortSignal): Promise<RunSnapshot> =>
  read(withRun(endpoints.run.path, run), endpoints.run.response, signal)

export const readFact = async (id: FactId, signal: AbortSignal): Promise<Fact> =>
  (await read(endpoints.fact.path.replace(':id', encodeURIComponent(id)), endpoints.fact.response, signal)).fact
