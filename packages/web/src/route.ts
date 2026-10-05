import { RunId, StageId } from '@aang/contract'
import { type MouseEvent, useCallback, useSyncExternalStore } from 'react'

const navigated = 'aang:navigate'

const subscribe = (notify: () => void): (() => void) => {
  window.addEventListener('popstate', notify)
  window.addEventListener(navigated, notify)
  return () => {
    window.removeEventListener('popstate', notify)
    window.removeEventListener(navigated, notify)
  }
}

const currentSearch = (): string => window.location.search

export const usagePeriods = ['all', 'day', 'week', 'month'] as const
export type UsagePeriod = (typeof usagePeriods)[number]

export type Route =
  | { readonly screen: 'runs' }
  | { readonly screen: 'run'; readonly run: RunId }
  | { readonly screen: 'usage'; readonly run: RunId | null; readonly period: UsagePeriod }

const usageView = 'usage'

const isPeriod = (value: string | null): value is UsagePeriod => usagePeriods.some((period) => period === value)

const routeOf = (search: string): Route => {
  const params = new URLSearchParams(search)
  const parsed = RunId.safeParse(params.get('run'))
  const run = parsed.success ? parsed.data : null
  if (params.get('view') === usageView) {
    const period = params.get('period')
    return { screen: 'usage', run, period: isPeriod(period) ? period : 'all' }
  }
  return run === null ? { screen: 'runs' } : { screen: 'run', run }
}

export type RunMode = 'trace' | 'changes'

export const runHref = (run: RunId, mode: RunMode = 'trace'): string =>
  `?${new URLSearchParams(mode === 'trace' ? { run } : { run, mode }).toString()}`

export const usageHref = (run: RunId | null, period: UsagePeriod = 'all'): string =>
  `?${new URLSearchParams({
    view: usageView,
    ...(run === null ? {} : { run }),
    ...(period === 'all' ? {} : { period }),
  }).toString()}`

export const listHref = '/'

export const useRoute = (): Route => routeOf(useSyncExternalStore(subscribe, currentSearch))

export const routedStage = (): StageId | null => {
  const parsed = StageId.safeParse(new URLSearchParams(currentSearch()).get('stage'))
  return parsed.success ? parsed.data : null
}

export const useRoutedMode = (): RunMode => {
  const search = useSyncExternalStore(subscribe, currentSearch)
  return new URLSearchParams(search).get('mode') === 'changes' ? 'changes' : 'trace'
}

export const routeStage = (stage: StageId | null): void => {
  const params = new URLSearchParams(currentSearch())
  if (stage === null) {
    params.delete('stage')
  } else {
    params.set('stage', stage)
  }
  const search = `?${params.toString()}`
  if (search !== currentSearch()) {
    window.history.replaceState(window.history.state, '', search)
  }
}

const isPlainClick = (event: MouseEvent): boolean =>
  event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey

export const useNavigate = (): ((event: MouseEvent<HTMLAnchorElement>) => void) =>
  useCallback((event: MouseEvent<HTMLAnchorElement>) => {
    if (!isPlainClick(event)) {
      return
    }
    event.preventDefault()
    window.history.pushState(null, '', event.currentTarget.href)
    window.dispatchEvent(new Event(navigated))
    window.scrollTo(0, 0)
  }, [])

export const useSwitchMode = (): ((event: MouseEvent<HTMLAnchorElement>) => void) =>
  useCallback((event: MouseEvent<HTMLAnchorElement>) => {
    if (!isPlainClick(event)) {
      return
    }
    event.preventDefault()
    window.history.replaceState(null, '', event.currentTarget.href)
    window.dispatchEvent(new Event(navigated))
  }, [])
