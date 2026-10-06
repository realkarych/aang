import { readSpool } from '@aang/testkit'

export interface HookRecord extends Readonly<Record<string, unknown>> {
  readonly hook_event_name: string
}

const isHookRecord = (value: unknown): value is HookRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && 'hook_event_name' in value && typeof value.hook_event_name === 'string'

export const hookRecords = async (spool: string): Promise<HookRecord[]> =>
  (await readSpool(spool)).flatMap((event) => {
    try {
      const payload: unknown = JSON.parse(event.payload.toString('utf8'))
      return isHookRecord(payload) ? [payload] : []
    } catch {
      return []
    }
  })

export const hooksNamed = (hooks: readonly HookRecord[], event: string, field?: { readonly key: string; readonly value: unknown }): HookRecord[] =>
  hooks.filter((hook) => hook.hook_event_name === event && (field === undefined || hook[field.key] === field.value))
