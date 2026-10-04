import { type ReactElement, useEffect, useId, useRef, useState } from 'react'

export const LongText = ({ text, className }: { readonly text: string; readonly className: string }): ReactElement => {
  const id = useId()
  const box = useRef<HTMLSpanElement>(null)
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
  return (
    <>
      <span id={id} ref={box} className={className} data-expanded={expanded}>
        {text}
      </span>
      {expanded || clipped ? (
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
      ) : null}
    </>
  )
}
