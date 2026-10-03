import { RunId } from '@aang/contract'
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

export const runHref = (run: RunId): string => `?${new URLSearchParams({ run }).toString()}`

export const listHref = '/'

export const useRoutedRun = (): RunId | null => {
  const search = useSyncExternalStore(subscribe, currentSearch)
  const parsed = RunId.safeParse(new URLSearchParams(search).get('run'))
  return parsed.success ? parsed.data : null
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
