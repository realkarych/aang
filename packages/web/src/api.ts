import {
  ApiError,
  type ArtifactVersionId,
  type ArtifactVersionResponse,
  type AttentionItemId,
  type AttentionView,
  type ChatMessage,
  type ChatQuestionRequest,
  endpoints,
  type Fact,
  type FactId,
  type RawRecord,
  type RawSeq,
  type RunId,
  type RunSnapshot,
  type RunsResponse,
  type StageId,
  type StageInspector,
  type StatusResponse,
  type ViewRule,
  type ViewRuleId,
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

class RequestFailed extends Error {
  override readonly name = 'RequestFailed'
}

export const failureText = (error: unknown): string =>
  error instanceof Unreachable ? 'no connection to the daemon' : error instanceof Error ? error.message : String(error)

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

const request = async <T>(path: string, init: RequestInit, decoder: Decoder<T>, signal: AbortSignal): Promise<T> => {
  let response: Response
  try {
    response = await fetch(path, { ...init, cache: 'no-store', signal })
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

const read = <T>(path: string, decoder: Decoder<T>, signal: AbortSignal): Promise<T> =>
  request(path, { headers: { accept: 'application/json' } }, decoder, signal)

const write = <T>(path: string, body: unknown, decoder: Decoder<T>, signal: AbortSignal): Promise<T> =>
  request(
    path,
    {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    decoder,
    signal,
  )

const post = <T>(path: string, decoder: Decoder<T>): Promise<T> =>
  write(path, {}, decoder, new AbortController().signal)

const send = async <T>(method: 'POST' | 'DELETE', path: string, body: unknown, decoder: Decoder<T>): Promise<T> => {
  let response: Response
  try {
    response = await fetch(path, {
      method,
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      cache: 'no-store',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  } catch (error) {
    throw new Unreachable(error instanceof Error ? error.message : String(error))
  }
  ensureSignedIn(response)
  if (!response.ok) {
    throw new RequestFailed(await failureMessage(response))
  }
  return decoder.parse(await response.json())
}

const withRun = (path: string, run: RunId): string => path.replace(':run', encodeURIComponent(run))

const withItem = (path: string, run: RunId, item: AttentionItemId): string =>
  withRun(path, run).replace(':item', encodeURIComponent(item))

export const readStatus = (signal: AbortSignal): Promise<StatusResponse> =>
  read(endpoints.status.path, endpoints.status.response, signal)

export const readRuns = (signal: AbortSignal): Promise<RunsResponse> =>
  read(endpoints.runs.path, endpoints.runs.response, signal)

export const readRun = (run: RunId, signal: AbortSignal): Promise<RunSnapshot> =>
  read(withRun(endpoints.run.path, run), endpoints.run.response, signal)

export const readFact = async (id: FactId, signal: AbortSignal): Promise<Fact> =>
  (await read(endpoints.fact.path.replace(':id', encodeURIComponent(id)), endpoints.fact.response, signal)).fact

export const readStage = (run: RunId, stage: StageId, signal: AbortSignal): Promise<StageInspector> =>
  read(
    withRun(endpoints.stage.path, run).replace(':stage', encodeURIComponent(stage)),
    endpoints.stage.response,
    signal,
  )

export const readRaw = async (seq: RawSeq, signal: AbortSignal): Promise<RawRecord> =>
  (await read(endpoints.raw.path.replace(':seq', String(seq)), endpoints.raw.response, signal)).raw

export const readArtifactVersion = (id: ArtifactVersionId, signal: AbortSignal): Promise<ArtifactVersionResponse> =>
  read(endpoints.artifactVersion.path.replace(':id', encodeURIComponent(id)), endpoints.artifactVersion.response, signal)

export const markAttentionViewed = async (run: RunId, item: AttentionItemId): Promise<AttentionView> =>
  (await post(withItem(endpoints.attentionViewed.path, run, item), endpoints.attentionViewed.response)).view

export const dismissAttention = async (run: RunId, item: AttentionItemId): Promise<AttentionView> =>
  (await post(withItem(endpoints.attentionDismiss.path, run, item), endpoints.attentionDismiss.response)).view

export const readChat = async (run: RunId, signal: AbortSignal): Promise<ChatMessage[]> =>
  (await read(withRun(endpoints.chatHistory.path, run), endpoints.chatHistory.response, signal)).messages

export const askChat = async (run: RunId, request: ChatQuestionRequest): Promise<ChatMessage> =>
  (await send('POST', withRun(endpoints.chatQuestion.path, run), request, endpoints.chatQuestion.response)).message

export const revokeViewRule = async (run: RunId, id: ViewRuleId): Promise<ViewRule> =>
  (
    await send(
      'DELETE',
      withRun(endpoints.revokeViewRule.path, run).replace(':id', encodeURIComponent(id)),
      undefined,
      endpoints.revokeViewRule.response,
    )
  ).rule
