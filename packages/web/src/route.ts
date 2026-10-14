import { RunId, StageId } from '@catacomb/contract'
import { type MouseEvent, useCallback, useSyncExternalStore } from 'react'

const navigated = 'catacomb:navigate'

const subscribe = (notify: () => void): (() => void) => {
  window.addEventListener('popstate', notify)
  window.addEventListener(navigated, notify)
  return () => {
    window.removeEventListener('popstate', notify)
    window.removeEventListener(navigated, notify)
  }
}

const currentSearch = (): string => window.location.search

export type Route = { readonly screen: 'runs' } | { readonly screen: 'run'; readonly run: RunId }

const routeOf = (search: string): Route => {
  const parsed = RunId.safeParse(new URLSearchParams(search).get('run'))
  return parsed.success ? { screen: 'run', run: parsed.data } : { screen: 'runs' }
}

export const runHref = (run: RunId): string => `?${new URLSearchParams({ run }).toString()}`

export const listHref = '/'

export const stageHref = (run: RunId, stage: StageId): string => `?${new URLSearchParams({ run, stage }).toString()}`

const useSearch = (): URLSearchParams => new URLSearchParams(useSyncExternalStore(subscribe, currentSearch))

export const useRoute = (): Route => routeOf(useSyncExternalStore(subscribe, currentSearch))

export const useRoutedStage = (): StageId | null => {
  const parsed = StageId.safeParse(useSearch().get('stage'))
  return parsed.success ? parsed.data : null
}

const go = (href: string): void => {
  window.history.pushState(null, '', href)
  window.dispatchEvent(new Event(navigated))
}

const stageLocation = (run: RunId, stage: StageId | null): string =>
  stage === null ? runHref(run) : stageHref(run, stage)

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

export const isPlainClick = (event: MouseEvent): boolean =>
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
