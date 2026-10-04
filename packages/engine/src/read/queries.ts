import type {
  ChangeSeq,
  ChangesResponse,
  ChatHistoryResponse,
  ObserverCallsResponse,
  RunId,
  RunSnapshot,
  RunsResponse,
  StageId,
  StageInspector,
  ViewPosition,
} from '@aang/contract'
import { runChanges } from './changes.js'
import { type ReadContext, runOf } from './context.js'
import { stageInspector } from './inspector.js'
import { runObserverCalls } from './observer-calls.js'
import { listRuns, type RunFeed, runFeed, runSnapshot } from './snapshot.js'

export type ReadQueriesOptions = ReadContext

export interface ReadQueries {
  readonly runs: () => RunsResponse
  readonly snapshot: (run: RunId) => RunSnapshot | null
  readonly feed: (run: RunId, after: ChangeSeq) => RunFeed | null
  readonly inspector: (run: RunId, stage: StageId) => StageInspector | null
  readonly changes: (run: RunId, from: ViewPosition) => ChangesResponse | null
  readonly observerCalls: (run: RunId) => ObserverCallsResponse | null
  readonly chat: (run: RunId) => ChatHistoryResponse | null
}

export const createReadQueries = (context: ReadQueriesOptions): ReadQueries => {
  const { store } = context
  return {
    runs: () => store.read(() => listRuns(context)),
    snapshot: (run) => store.read(() => runSnapshot(context, run)),
    feed: (run, after) => store.read(() => runFeed(context, run, after)),
    inspector: (run, stage) => store.read(() => stageInspector(context, run, stage)),
    changes: (run, from) => store.read(() => runChanges(context, run, from)),
    observerCalls: (run) =>
      store.read(() => {
        const calls = runObserverCalls(context, run)
        return calls === null ? null : { calls }
      }),
    chat: (run) => store.read(() => (runOf(store, run) === null ? null : { messages: store.chat.messages(run) })),
  }
}
