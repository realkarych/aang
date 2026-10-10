import { type ReactElement, type RefObject, useEffect, useId, useRef, useState } from 'react'

export interface LongTextState<E extends HTMLElement> {
  readonly id: string
  readonly box: RefObject<E | null>
  readonly expanded: boolean
  readonly toggle: ReactElement | null
}

export const useLongText = <E extends HTMLElement>(text: string): LongTextState<E> => {
  const id = useId()
  const box = useRef<E>(null)
  const [expanded, setExpanded] = useState(false)
  const [clipped, setClipped] = useState(false)
  useEffect(() => {
    const element = box.current
    if (element === null || expanded) {
      return
    }
    const observer = new ResizeObserver(() => {
      setClipped(element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth)
    })
    observer.observe(element)
    return () => {
      observer.disconnect()
    }
  }, [text, expanded])
  const toggle =
    expanded || clipped ? (
      <button
        type="button"
        className="text-button text-toggle"
        aria-expanded={expanded}
        aria-controls={id}
        onClick={() => {
          setExpanded(!expanded)
        }}
      >
        {expanded ? 'Свернуть' : 'Показать полностью'}
      </button>
    ) : null
  return { id, box, expanded, toggle }
}

export const LongText = ({ text, className }: { readonly text: string; readonly className: string }): ReactElement => {
  const { id, box, expanded, toggle } = useLongText<HTMLSpanElement>(text)
  return (
    <>
      <span id={id} ref={box} className={className} data-expanded={expanded}>
        {text}
      </span>
      {toggle}
    </>
  )
}
