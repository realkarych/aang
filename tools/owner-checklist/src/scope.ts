import { isAbsolute, relative, sep } from 'node:path'
import { pathForms } from './anonymize.js'
import { type ChecklistEvent, textField } from './events.js'

export interface ScopedEvents {
  readonly events: readonly ChecklistEvent[]
  readonly droppedEvents: number
  readonly droppedSessions: number
}

const isInside = (root: string, path: string): boolean => {
  const inside = relative(root, path)
  return inside === '' || (inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside))
}

const sessionKey = (event: ChecklistEvent): string => `${event.runtime}\u0000${event.sessionId ?? ''}`

export const scopeEvents = (events: readonly ChecklistEvent[], roots: readonly string[]): ScopedEvents => {
  const forms = roots.flatMap(pathForms)
  const kept = new Set(
    events
      .filter((event) => {
        const cwd = textField(event, 'cwd')
        return cwd !== null && forms.some((root) => isInside(root, cwd))
      })
      .map(sessionKey),
  )
  const inScope = (event: ChecklistEvent): boolean => event.sessionId === null || kept.has(sessionKey(event))
  const dropped = events.filter((event) => !inScope(event))
  return {
    events: events.filter(inScope),
    droppedEvents: dropped.length,
    droppedSessions: new Set(dropped.map(sessionKey)).size,
  }
}
