import { type Binding, endpoints } from '@aang/contract'
import {
  addViewRule,
  BindingError,
  createViewState,
  InvalidPositionError,
  revokeViewRule,
  ViewRuleError,
} from '@aang/engine'
import type { Store } from '@aang/store'
import type { Bindings } from './ingestion.js'
import { ApiFailure, type ApiRoute, writeRoute } from './routes.js'
import { epochNow } from './spool.js'

export interface WriteSources {
  readonly store: Store
  readonly bindings: Bindings
}

const refusal = (error: unknown): unknown => {
  if (error instanceof InvalidPositionError || error instanceof ViewRuleError) {
    return new ApiFailure('invalid_request', error.message)
  }
  if (error instanceof BindingError) {
    return new ApiFailure(error.code, error.message)
  }
  return error
}

const refusing = async <T>(work: () => T | Promise<T>): Promise<T> => {
  try {
    return await work()
  } catch (error) {
    throw refusal(error)
  }
}

const settled = async (pending: Promise<Binding | null>): Promise<{ readonly binding: Binding }> => {
  const binding = await refusing(() => pending)
  if (binding === null) {
    throw new ApiFailure('unavailable', 'the daemon is stopping')
  }
  return { binding }
}

export const writeRoutes = ({ store, bindings }: WriteSources): ApiRoute[] => {
  const views = createViewState({ store, now: epochNow })
  return [
    writeRoute(endpoints.markViewed, ({ params, body }) =>
      refusing(() => {
        const mark = views.markViewed(params.run, body)
        return mark === null ? null : { mark }
      }),
    ),
    writeRoute(endpoints.attentionViewed, ({ params }) => {
      const view = views.viewItem(params.run, params.item)
      return view === null ? null : { view }
    }),
    writeRoute(endpoints.attentionDismiss, ({ params }) => {
      const view = views.dismissItem(params.run, params.item)
      return view === null ? null : { view }
    }),
    writeRoute(endpoints.createViewRule, ({ params, body }) =>
      refusing(() => {
        const rule = store.transaction((transaction) =>
          addViewRule(transaction, { run: params.run, rule: body, source: 'ui', at: epochNow() }),
        )
        return rule === null ? null : { rule }
      }),
    ),
    writeRoute(endpoints.revokeViewRule, ({ params }) => {
      const rule = store.transaction((transaction) =>
        revokeViewRule(transaction, { run: params.run, id: params.id, at: epochNow() }),
      )
      return rule === null ? null : { rule }
    }),
    writeRoute(endpoints.createBinding, ({ body }) => settled(bindings.bind(body))),
    writeRoute(endpoints.revokeBinding, ({ params }) => settled(bindings.revoke(params.id))),
  ]
}
