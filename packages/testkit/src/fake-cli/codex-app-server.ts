import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { JsonValue } from '@aang/contract'
import type { z } from 'zod'
import { emit, isJsonObject, parseJson, readText } from './io.js'
import type { CodexScenario } from './scenario.js'

type HookState = Exclude<z.output<typeof CodexScenario>['hooks'], 'unlisted'>
type ListedHooks = z.output<typeof CodexScenario>['hooks']
type JsonObject = { readonly [key: string]: JsonValue }

const listedState: Readonly<Record<HookState, { readonly trustStatus: string; readonly enabled: boolean }>> = {
  untrusted: { trustStatus: 'untrusted', enabled: true },
  trusted: { trustStatus: 'trusted', enabled: true },
  disabled: { trustStatus: 'trusted', enabled: false },
}

const keyEvent = (event: string): string =>
  event.replace(/[A-Z]/g, (letter, index: number) => `${index === 0 ? '' : '_'}${letter.toLowerCase()}`)

const listedEvent = (event: string): string => `${event.slice(0, 1).toLowerCase()}${event.slice(1)}`

const objects = (value: JsonValue | undefined): JsonObject[] =>
  Array.isArray(value) ? value.filter((item): item is JsonObject => isJsonObject(item)) : []

const listHooks = (codexHome: string, state: ListedHooks): JsonValue[] => {
  if (state === 'unlisted') {
    return []
  }
  const sourcePath = join(codexHome, 'hooks.json')
  const document = parseJson(readText(sourcePath)?.replace(/^\uFEFF/, ''))
  const events = isJsonObject(document) && isJsonObject(document.hooks) ? Object.entries(document.hooks) : []
  return events.flatMap(([event, groups]) =>
    objects(groups).flatMap((group, groupIndex) =>
      objects(group.hooks).map((handler, handlerIndex) => ({
        key: `${sourcePath}:${keyEvent(event)}:${String(groupIndex)}:${String(handlerIndex)}`,
        eventName: listedEvent(event),
        handlerType: handler.type ?? 'command',
        ...(handler.command === undefined ? {} : { command: handler.command }),
        timeoutSec: handler.timeout ?? null,
        sourcePath,
        source: 'user',
        isManaged: false,
        currentHash: `sha256:${createHash('sha256').update(JSON.stringify(handler)).digest('hex')}`,
        ...listedState[state],
      })),
    ),
  )
}

export const serveAppServer = async (state: ListedHooks): Promise<void> => {
  const codexHome = process.env.CODEX_HOME ?? ''
  for await (const line of createInterface({ input: process.stdin })) {
    const request = parseJson(line)
    if (!isJsonObject(request) || request.id === undefined) {
      continue
    }
    if (request.method === 'initialize') {
      emit({ id: request.id, result: { userAgent: 'fake-codex', codexHome } })
    } else if (request.method === 'hooks/list') {
      emit({
        id: request.id,
        result: { data: [{ cwd: process.cwd(), hooks: listHooks(codexHome, state), errors: [], warnings: [] }] },
      })
    } else {
      const method = JSON.stringify(request.method ?? null)
      emit({ id: request.id, error: { code: -32601, message: `unsupported method ${method}` } })
    }
  }
}
