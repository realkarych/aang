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

export const stageHref = (run: RunId, stage: StageId, mode: RunMode = 'trace'): string =>
  `?${new URLSearchParams(mode === 'trace' ? { run, stage } : { run, stage, mode }).toString()}`

export const viewHref = (run: RunId, stage: StageId | null, mode: RunMode): string =>
  stage === null ? runHref(run, mode) : stageHref(run, stage, mode)

const useSearch = (): URLSearchParams => new URLSearchParams(useSyncExternalStore(subscribe, currentSearch))

export const useRoute = (): Route => routeOf(useSyncExternalStore(subscribe, currentSearch))

export const useRoutedStage = (): StageId | null => {
  const parsed = StageId.safeParse(useSearch().get('stage'))
  return parsed.success ? parsed.data : null
}

const modeOf = (params: URLSearchParams): RunMode => (params.get('mode') === 'changes' ? 'changes' : 'trace')

export const useRoutedMode = (): RunMode => modeOf(useSearch())

const go = (href: string): void => {
  window.history.pushState(null, '', href)
  window.dispatchEvent(new Event(navigated))
}

const stageLocation = (run: RunId, stage: StageId | null): string =>
  viewHref(run, stage, modeOf(new URLSearchParams(currentSearch())))

export const selectStage = (run: RunId, stage: StageId | null): void => {
  go(stageLocation(run, stage))
}

export const replaceStage = (run: RunId, stage: StageId | null): void => {
  const href = stageLocation(run, stage)
  if (href !== currentSearch()) {
    window.history.replaceState(window.history.state, '', href)
    window.dispatchEvent(new Event(navigated))
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
    go(event.currentTarget.href)
    window.scrollTo(0, 0)
  }, [])

export const useSelect = (): ((event: MouseEvent<HTMLAnchorElement>) => void) =>
  useCallback((event: MouseEvent<HTMLAnchorElement>) => {
    if (!isPlainClick(event)) {
      return
    }
    event.preventDefault()
    go(event.currentTarget.href)
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
