import { type ChangesQuery, type ChangesResponse, endpoints, type RunId, type StatusResponse } from '@aang/contract'
import { createReadQueries, InvalidPositionError, type ObserverRunStatus, type ReadQueries } from '@aang/engine'
import type { Store } from '@aang/store'
import { ApiFailure, type ApiRoute, readRoute } from './routes.js'

export interface ReadSources {
  readonly store: Store
  readonly status: () => Promise<StatusResponse>
}

const unadmittedObserver: ObserverRunStatus = {
  state: { state: 'disabled', reason: 'version_not_admitted' },
  isolation_unverified: false,
}

const changesSince = (reads: ReadQueries, run: RunId, { version, seq }: ChangesQuery): ChangesResponse | null => {
  try {
    return reads.changes(run, { version, change_seq: seq })
  } catch (error) {
    throw error instanceof InvalidPositionError ? new ApiFailure('invalid_request', error.message) : error
  }
}

export const readRoutes = ({ store, status }: ReadSources): ApiRoute[] => {
  const reads = createReadQueries({ store, observer: () => unadmittedObserver })
  return [
    readRoute(endpoints.status, status),
    readRoute(endpoints.runs, () => reads.runs()),
    readRoute(endpoints.run, ({ params }) => reads.snapshot(params.run)),
    readRoute(endpoints.stage, ({ params }) => reads.inspector(params.run, params.stage)),
    readRoute(endpoints.changes, ({ params, query }) => changesSince(reads, params.run, query)),
    readRoute(endpoints.observerCalls, ({ params }) => reads.observerCalls(params.run)),
    readRoute(endpoints.fact, ({ params }) => {
      const fact = store.facts.get(params.id)
      return fact === null ? null : { fact }
    }),
    readRoute(endpoints.raw, ({ params }) => {
      const raw = store.rawRecords.get(params.seq)
      return raw === null ? null : { raw }
    }),
  ]
}
