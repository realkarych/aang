import { type ReactElement, type ReactNode, useEffect, useId, useState } from 'react'
import './dock.css'

const collapsedKey = 'aang:chat-collapsed'
const wideQuery = '(min-width: 1100px)'

const storedCollapsed = (): boolean => {
  try {
    return window.localStorage.getItem(collapsedKey) === 'true'
  } catch {
    return false
  }
}

const storeCollapsed = (collapsed: boolean): void => {
  try {
    window.localStorage.setItem(collapsedKey, String(collapsed))
  } catch {
    return
  }
}

const useWide = (): boolean => {
  const [wide, setWide] = useState(() => window.matchMedia(wideQuery).matches)
  useEffect(() => {
    const query = window.matchMedia(wideQuery)
    const update = (): void => {
      setWide(query.matches)
    }
    query.addEventListener('change', update)
    return () => {
      query.removeEventListener('change', update)
    }
  }, [])
  return wide
}

export const ChatDock = ({ children }: { readonly children: ReactNode }): ReactElement => {
  const wide = useWide()
  const [collapsedWide, setCollapsedWide] = useState(storedCollapsed)
  const [openNarrow, setOpenNarrow] = useState(false)
  const body = useId()
  const collapsed = wide ? collapsedWide : !openNarrow
  const toggle = (): void => {
    if (wide) {
      storeCollapsed(!collapsedWide)
      setCollapsedWide(!collapsedWide)
    } else {
      setOpenNarrow(!openNarrow)
    }
  }
  return (
    <aside className="chat-dock" aria-label="Chat panel" data-collapsed={collapsed}>
      <button type="button" className="dock-toggle" aria-expanded={!collapsed} aria-controls={body} onClick={toggle}>
        {collapsed ? 'Expand chat' : 'Collapse chat'}
      </button>
      <div id={body} className="dock-body" hidden={collapsed}>
        {children}
      </div>
    </aside>
  )
}
