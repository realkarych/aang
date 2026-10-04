import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  type ApiError,
  type ChangeSeq,
  ChangeSeqText,
  type ResetReason,
  type RunId,
  SseEvent,
  StreamQuery,
} from '@aang/contract'
import { InvalidPositionError, type ReadQueries, type RunFeed } from '@aang/engine'

export type StreamRefusal = ApiError['error']

export interface StreamsOptions {
  readonly reads: ReadQueries
  readonly head: () => ChangeSeq
  readonly onError: (error: unknown) => void
}

export interface Streams {
  readonly open: (request: IncomingMessage, response: ServerResponse, query: URLSearchParams) => StreamRefusal | null
  readonly changed: () => void
  readonly close: () => void
}

interface Subscriber {
  readonly run: RunId
  readonly response: ServerResponse
  position: ChangeSeq
  delta: string | null
  blocked: boolean
}

const dataOf = (event: SseEvent): string => JSON.stringify(SseEvent.encode(event).data)

const frame = (event: SseEvent, data = dataOf(event)): string =>
  `${event.id === null ? '' : `id: ${String(event.id)}\n`}event: ${event.event}\ndata: ${data}\n\n`

const begin = (response: ServerResponse): void => {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
  })
}

const resetFrame = (reason: ResetReason): string => frame({ event: 'reset', id: null, data: { reason } })

type Position = { readonly kind: 'absent' } | { readonly kind: 'at'; readonly seq: ChangeSeq } | { readonly kind: 'invalid' }

const positionOf = (header: string | string[] | undefined): Position => {
  if (header === undefined || header === '') {
    return { kind: 'absent' }
  }
  const parsed = ChangeSeqText.safeParse(header)
  return parsed.success ? { kind: 'at', seq: parsed.data } : { kind: 'invalid' }
}

type Reading =
  | { readonly kind: 'feed'; readonly feed: RunFeed }
  | { readonly kind: 'gone' }
  | { readonly kind: 'stale'; readonly reason: ResetReason }

export const createStreams = ({ reads, head, onError }: StreamsOptions): Streams => {
  const subscribers = new Set<Subscriber>()
  const state: { closed: boolean; pending: NodeJS.Immediate | null } = { closed: false, pending: null }

  const read = (run: RunId, after: ChangeSeq): Reading => {
    try {
      const feed = reads.feed(run, after)
      return feed === null ? { kind: 'gone' } : { kind: 'feed', feed }
    } catch (error) {
      if (error instanceof InvalidPositionError) {
        return { kind: 'stale', reason: error.reason }
      }
      throw error
    }
  }

  const send = (subscriber: Subscriber, { events, position, run }: RunFeed): void => {
    const runEvent: SseEvent = { event: 'run', id: position, data: run }
    const delta = dataOf(runEvent)
    const frames = events.map((event) => frame(event))
    if (frames.length > 0 || delta !== subscriber.delta) {
      frames.push(frame(runEvent, delta))
    }
    subscriber.position = position
    subscriber.delta = delta
    if (frames.length > 0) {
      subscriber.blocked = !subscriber.response.write(frames.join(''))
    }
  }

  const reset = (response: ServerResponse, reason: ResetReason): void => {
    response.end(resetFrame(reason))
  }

  const deliver = (subscriber: Subscriber): void => {
    if (subscriber.blocked) {
      return
    }
    try {
      const reading = read(subscriber.run, subscriber.position)
      if (reading.kind === 'feed') {
        send(subscriber, reading.feed)
      } else {
        subscribers.delete(subscriber)
        reset(subscriber.response, reading.kind === 'stale' ? reading.reason : 'stale_position')
      }
    } catch (error) {
      onError(error)
      subscribers.delete(subscriber)
      subscriber.response.destroy()
    }
  }

  const flush = (): void => {
    state.pending = null
    for (const subscriber of subscribers) {
      deliver(subscriber)
    }
  }

  return {
    open: (request, response, query) => {
      if (state.closed) {
        return { code: 'unavailable', message: 'the daemon is stopping' }
      }
      const parsed = StreamQuery.safeParse(Object.fromEntries(query))
      if (!parsed.success) {
        return { code: 'invalid_request', message: 'the stream takes a run id in the run parameter' }
      }
      const { run } = parsed.data
      if (run === undefined) {
        return { code: 'invalid_request', message: 'the stream needs a run' }
      }
      const position = positionOf(request.headers['last-event-id'])
      if (position.kind === 'invalid') {
        return { code: 'invalid_request', message: 'Last-Event-ID must be a change_seq' }
      }
      const reading = read(run, position.kind === 'at' ? position.seq : head())
      if (reading.kind === 'gone') {
        return { code: 'not_found', message: `no run ${run}` }
      }
      begin(response)
      if (reading.kind === 'stale') {
        reset(response, reading.reason)
        return null
      }
      const subscriber: Subscriber = { run, response, position: reading.feed.position, delta: null, blocked: false }
      subscribers.add(subscriber)
      response.on('close', () => {
        subscribers.delete(subscriber)
      })
      response.on('drain', () => {
        subscriber.blocked = false
        deliver(subscriber)
      })
      send(subscriber, reading.feed)
      return null
    },
    changed: () => {
      if (!state.closed && state.pending === null) {
        state.pending = setImmediate(flush)
      }
    },
    close: () => {
      state.closed = true
      if (state.pending !== null) {
        clearImmediate(state.pending)
        state.pending = null
      }
      for (const subscriber of subscribers) {
        subscriber.response.end()
      }
      subscribers.clear()
    },
  }
}
