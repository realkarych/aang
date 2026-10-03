import { callsOf, type ChecklistEvent, numberField, textField } from './events.js'

export interface Session {
  readonly runtime: string
  readonly sessionId: string | null
  readonly events: readonly ChecklistEvent[]
}

export interface PermissionChain {
  readonly request: ChecklistEvent
  readonly toolName: string | null
  readonly toolUseId: string | null
  readonly promptDelayMs: number | null
  readonly outcome: string
}

export interface IdleChain {
  readonly stop: ChecklistEvent
  readonly idleDelayMs: number | null
  readonly backgroundTasks: number | null
}

export interface ToolChain {
  readonly pre: ChecklistEvent
  readonly toolUseId: string | null
  readonly permission: boolean
  readonly notifications: readonly string[]
  readonly post: ChecklistEvent | null
  readonly deniedInBatch: boolean
  readonly durationMs: number | null
}

export interface ToolPairs {
  readonly paired: number
  readonly failed: number
  readonly unpaired: readonly { readonly toolName: string | null; readonly toolUseId: string; readonly deniedInBatch: boolean }[]
}

const completions: readonly string[] = ['PostToolUse', 'PostToolUseFailure']

export const groupSessions = (events: readonly ChecklistEvent[]): Session[] => {
  const sessions = new Map<string, { runtime: string; sessionId: string | null; events: ChecklistEvent[] }>()
  for (const event of events) {
    const key = `${event.runtime}\u0000${event.sessionId ?? ''}`
    const session = sessions.get(key) ?? { runtime: event.runtime, sessionId: event.sessionId, events: [] }
    session.events.push(event)
    sessions.set(key, session)
  }
  return [...sessions.values()]
}

export const elapsedMs = (from: ChecklistEvent, to: ChecklistEvent): number =>
  Number(to.receivedNs - from.receivedNs) / 1_000_000

const named = (event: ChecklistEvent, name: string): boolean => event.event === name

const notificationOf = (event: ChecklistEvent, type: string): boolean =>
  named(event, 'Notification') && textField(event, 'notification_type') === type

const firstBetween = (
  events: readonly ChecklistEvent[],
  start: number,
  matches: (event: ChecklistEvent) => boolean,
  stops: (event: ChecklistEvent) => boolean,
): ChecklistEvent | null => {
  for (const event of events.slice(start + 1)) {
    if (matches(event)) {
      return event
    }
    if (stops(event)) {
      return null
    }
  }
  return null
}

const completionOf = (events: readonly ChecklistEvent[], start: number, toolUseId: string): ChecklistEvent | null =>
  events
    .slice(start + 1)
    .find((event) => completions.includes(event.event ?? '') && textField(event, 'tool_use_id') === toolUseId) ?? null

const deniedInBatch = (events: readonly ChecklistEvent[], start: number, toolUseId: string): boolean =>
  events
    .slice(start + 1)
    .some((event) => named(event, 'PostToolBatch') && callsOf(event).some((call) => call.tool_use_id === toolUseId))

export const surfaceOf = (session: Session): string => {
  const entrypoint = session.events.map((event) => event.env.CLAUDE_CODE_ENTRYPOINT).find((value) => value !== undefined)
  return entrypoint ?? (session.runtime === 'codex' ? 'codex' : 'неизвестно')
}

export const permissionChains = (session: Session): PermissionChain[] => {
  const { events } = session
  return events.flatMap((request, index) => {
    if (!named(request, 'PermissionRequest')) {
      return []
    }
    const toolName = textField(request, 'tool_name')
    const pre = events
      .slice(0, index)
      .findLast((event) => named(event, 'PreToolUse') && textField(event, 'tool_name') === toolName)
    const toolUseId = pre === undefined ? null : textField(pre, 'tool_use_id')
    const prompt = firstBetween(
      events,
      index,
      (event) => notificationOf(event, 'permission_prompt'),
      (event) => named(event, 'PermissionRequest'),
    )
    const completion = toolUseId === null ? null : completionOf(events, index, toolUseId)
    const outcome =
      toolUseId === null
        ? 'нет PreToolUse с этим инструментом'
        : completion !== null
          ? `разрешено (${completion.event ?? ''})`
          : deniedInBatch(events, index, toolUseId)
            ? 'отклонено (есть в PostToolBatch, нет Post*)'
            : 'исхода нет'
    return [
      {
        request,
        toolName,
        toolUseId,
        promptDelayMs: prompt === null ? null : elapsedMs(request, prompt),
        outcome,
      },
    ]
  })
}

export const idleChains = (session: Session): IdleChain[] => {
  const { events } = session
  return events.flatMap((stop, index) => {
    if (!named(stop, 'Stop')) {
      return []
    }
    const idle = firstBetween(
      events,
      index,
      (event) => notificationOf(event, 'idle_prompt'),
      (event) => named(event, 'UserPromptSubmit') || named(event, 'SessionEnd'),
    )
    return [{ stop, idleDelayMs: idle === null ? null : elapsedMs(stop, idle), backgroundTasks: numberField(stop, 'background_tasks') }]
  })
}

export const toolChains = (session: Session, toolName: string): ToolChain[] => {
  const { events } = session
  return events.flatMap((pre, index) => {
    if (!named(pre, 'PreToolUse') || textField(pre, 'tool_name') !== toolName) {
      return []
    }
    const toolUseId = textField(pre, 'tool_use_id')
    const post = toolUseId === null ? null : completionOf(events, index, toolUseId)
    const end = post === null ? events.length : events.indexOf(post)
    const between = events.slice(index + 1, end)
    return [
      {
        pre,
        toolUseId,
        permission: between.some((event) => named(event, 'PermissionRequest') && textField(event, 'tool_name') === toolName),
        notifications: between.filter((event) => named(event, 'Notification')).map((event) => textField(event, 'notification_type') ?? '?'),
        post,
        deniedInBatch: post === null && toolUseId !== null && deniedInBatch(events, index, toolUseId),
        durationMs: post === null ? null : elapsedMs(pre, post),
      },
    ]
  })
}

export const toolPairs = (session: Session): ToolPairs => {
  const { events } = session
  let paired = 0
  let failed = 0
  const unpaired: { toolName: string | null; toolUseId: string; deniedInBatch: boolean }[] = []
  events.forEach((event, index) => {
    const toolUseId = textField(event, 'tool_use_id')
    if (!named(event, 'PreToolUse') || toolUseId === null) {
      return
    }
    const completion = completionOf(events, index, toolUseId)
    if (completion === null) {
      unpaired.push({ toolName: textField(event, 'tool_name'), toolUseId, deniedInBatch: deniedInBatch(events, index, toolUseId) })
    } else if (completion.event === 'PostToolUseFailure') {
      failed += 1
    } else {
      paired += 1
    }
  })
  return { paired, failed, unpaired }
}

export const countEvents = (session: Session, name: string): number =>
  session.events.filter((event) => named(event, name)).length

export const distinctText = (session: Session, eventName: string | null, field: string): string[] => [
  ...new Set(
    session.events
      .filter((event) => eventName === null || named(event, eventName))
      .flatMap((event) => textField(event, field) ?? []),
  ),
]

export const distinctEnv = (session: Session, name: string): string[] => [
  ...new Set(session.events.flatMap((event) => event.env[name] ?? [])),
]
