import { type ChangeSeq, type ResetReason, type RunId, SseEvent, streamPath } from '@aang/contract'
import { ensureSignedIn } from './api.js'
import { pause } from './pause.js'

export type FeedEvent = Exclude<SseEvent, { readonly event: 'reset' }>

export type StreamEnd =
  | { readonly kind: 'reset'; readonly reason: ResetReason }
  | { readonly kind: 'gone' }
  | { readonly kind: 'aborted' }

export interface StreamHandlers {
  readonly onOpen: () => void
  readonly onEvent: (event: FeedEvent) => void
  readonly onInterrupted: () => void
}

interface Frame {
  readonly event: string
  readonly data: string
  readonly id: string | null
}

type Attempt = StreamEnd | { readonly kind: 'dropped'; readonly opened: boolean }

const retryDelaysMs = [250, 500, 1_000, 2_000, 4_000] as const

const lineBreak = /\r\n|\r|\n/

async function* lines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        return
      }
      buffer += decoder.decode(value, { stream: true })
      const held = buffer.endsWith('\r') ? '\r' : ''
      const parts = buffer.slice(0, buffer.length - held.length).split(lineBreak)
      buffer = (parts.pop() ?? '') + held
      yield* parts
    }
  } finally {
    reader.releaseLock()
  }
}

async function* frames(body: ReadableStream<Uint8Array>): AsyncGenerator<Frame> {
  let event = ''
  let data: string[] = []
  let id: string | null = null
  for await (const line of lines(body)) {
    if (line === '') {
      if (data.length > 0) {
        yield { event: event === '' ? 'message' : event, data: data.join('\n'), id }
      }
      event = ''
      data = []
      id = null
      continue
    }
    if (line.startsWith(':')) {
      continue
    }
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    const raw = colon === -1 ? '' : line.slice(colon + 1)
    const value = raw.startsWith(' ') ? raw.slice(1) : raw
    if (field === 'event') {
      event = value
    } else if (field === 'data') {
      data.push(value)
    } else if (field === 'id') {
      id = value
    }
  }
}

const decode = ({ event, data, id }: Frame): SseEvent | null => {
  let payload: unknown
  try {
    payload = JSON.parse(data)
  } catch {
    return null
  }
  const parsed = SseEvent.safeParse({ event, id: id === null ? null : Number(id), data: payload })
  return parsed.success ? parsed.data : null
}

const streamUrl = (run: RunId): string => `${streamPath}?${new URLSearchParams({ run }).toString()}`

export const followRun = async (
  run: RunId,
  from: ChangeSeq,
  handlers: StreamHandlers,
  signal: AbortSignal,
): Promise<StreamEnd> => {
  let position = from

  const attempt = async (): Promise<Attempt> => {
    let response: Response
    try {
      response = await fetch(streamUrl(run), {
        headers: { accept: 'text/event-stream', 'last-event-id': String(position) },
        cache: 'no-store',
        signal,
      })
    } catch {
      return signal.aborted ? { kind: 'aborted' } : { kind: 'dropped', opened: false }
    }
    ensureSignedIn(response)
    if (response.status === 404) {
      return { kind: 'gone' }
    }
    if (!response.ok || response.body === null) {
      await response.body?.cancel()
      return { kind: 'dropped', opened: false }
    }
    handlers.onOpen()
    try {
      for await (const frame of frames(response.body)) {
        const event = decode(frame)
        if (event?.event === 'reset') {
          return { kind: 'reset', reason: event.data.reason }
        }
        if (event !== null) {
          position = event.id
          handlers.onEvent(event)
        }
      }
    } catch {
      if (signal.aborted) {
        return { kind: 'aborted' }
      }
    }
    return { kind: 'dropped', opened: true }
  }

  let failures = 0
  while (!signal.aborted) {
    const outcome = await attempt()
    if (outcome.kind !== 'dropped') {
      return outcome
    }
    handlers.onInterrupted()
    failures = outcome.opened ? 0 : failures + 1
    await pause(retryDelaysMs[Math.min(failures, retryDelaysMs.length - 1)] ?? 0, signal)
  }
  return { kind: 'aborted' }
}
