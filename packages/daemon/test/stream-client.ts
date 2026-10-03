import { SseEvent, streamPath } from '@aang/contract'
import type { FeedEvent, FeedSegment } from '@aang/testkit'
import { bearer } from './daemon.js'

export interface StreamRequest {
  readonly run?: string
  readonly lastEventId?: string
  readonly token?: string | null
}

export interface EventStream {
  readonly events: readonly SseEvent[]
  readonly ended: Promise<void>
  readonly until: (condition: (events: readonly SseEvent[]) => boolean, timeoutMs?: number) => Promise<void>
  readonly close: () => Promise<void>
}

export const requestStream = (
  base: string,
  token: string,
  { run, lastEventId, token: credential = token }: StreamRequest,
  signal?: AbortSignal,
): Promise<Response> => {
  const url = new URL(streamPath, base)
  if (run !== undefined) {
    url.searchParams.set('run', run)
  }
  return fetch(url, {
    headers: {
      accept: 'text/event-stream',
      ...(credential === null ? {} : bearer(credential)),
      ...(lastEventId === undefined ? {} : { 'last-event-id': lastEventId }),
    },
    ...(signal === undefined ? {} : { signal }),
  })
}

const parseBlock = (block: string): SseEvent | null => {
  const fields = new Map<string, string>()
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) {
      continue
    }
    const colon = line.indexOf(':')
    const name = colon === -1 ? line : line.slice(0, colon)
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '')
    const previous = fields.get(name)
    fields.set(name, name === 'data' && previous !== undefined ? `${previous}\n${value}` : value)
  }
  const data = fields.get('data')
  if (data === undefined) {
    return null
  }
  const id = fields.get('id')
  return SseEvent.parse({
    event: fields.get('event') ?? 'message',
    id: id === undefined ? null : Number(id),
    data: JSON.parse(data) as unknown,
  })
}

const pollMs = 10

export const openStream = async (base: string, token: string, request: StreamRequest): Promise<EventStream> => {
  const controller = new AbortController()
  const response = await requestStream(base, token, request, controller.signal)
  const { body } = response
  if (response.status !== 200 || body === null) {
    throw new Error(`the stream was refused with ${String(response.status)}: ${await response.text()}`)
  }
  if (response.headers.get('content-type') !== 'text/event-stream; charset=utf-8') {
    throw new Error(`the stream has the content type ${String(response.headers.get('content-type'))}`)
  }
  const events: SseEvent[] = []
  const state: { finished: boolean; failure: unknown } = { finished: false, failure: null }
  const read = async (): Promise<void> => {
    const reader = body.pipeThrough(new TextDecoderStream()).getReader()
    let buffer = ''
    try {
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
        buffer += chunk.value
        for (let end = buffer.indexOf('\n\n'); end !== -1; end = buffer.indexOf('\n\n')) {
          const event = parseBlock(buffer.slice(0, end))
          buffer = buffer.slice(end + 2)
          if (event !== null) {
            events.push(event)
          }
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        state.failure = error
        throw error
      }
    } finally {
      state.finished = true
    }
  }
  const ended = read()
  ended.catch(() => undefined)
  return {
    events,
    ended,
    until: async (condition, timeoutMs = 20_000) => {
      const deadline = Date.now() + timeoutMs
      while (!condition(events)) {
        if (state.finished) {
          throw new Error('the stream ended before the condition was met', { cause: state.failure })
        }
        if (Date.now() > deadline) {
          throw new Error(`the stream did not meet the condition within ${String(timeoutMs)} ms`)
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs))
      }
    },
    close: async () => {
      controller.abort()
      await ended
    },
  }
}

export const openKnownRun = async (
  base: string,
  token: string,
  request: StreamRequest,
  timeoutMs = 20_000,
): Promise<EventStream> => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const probe = await requestStream(base, token, { ...request, lastEventId: '0' })
    await probe.body?.cancel()
    if (probe.status !== 404) {
      return openStream(base, token, request)
    }
    if (Date.now() > deadline) {
      throw new Error(`the run ${String(request.run)} did not appear within ${String(timeoutMs)} ms`)
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}

const isFeedEvent = (event: SseEvent): event is FeedEvent & SseEvent =>
  event.event === 'facts' || event.event === 'model'

export const segmentsOf = (events: readonly SseEvent[]): FeedSegment[] => {
  const segments: FeedSegment[] = []
  let pending: FeedEvent[] = []
  for (const event of events) {
    if (isFeedEvent(event)) {
      pending.push(event)
    } else if (event.event === 'run') {
      segments.push({ position: event.id, events: pending, run: event.data })
      pending = []
    } else {
      throw new Error(`the run stream carried an unexpected ${event.event} event`)
    }
  }
  if (pending.length > 0) {
    throw new Error('the run stream ended without the run delta of its last changes')
  }
  return segments
}

export const lastId = (events: readonly SseEvent[]): number => {
  const ids = events.flatMap(({ id }) => (id === null ? [] : [id]))
  const last = ids.at(-1)
  if (last === undefined) {
    throw new Error('the stream carried no event with an id')
  }
  return last
}

export const endsWithRun = (events: readonly SseEvent[]): boolean => events.at(-1)?.event === 'run'
