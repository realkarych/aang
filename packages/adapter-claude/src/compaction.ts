import type { CompactionTrigger } from '@aang/contract'

const compactionTriggers: ReadonlyMap<string, CompactionTrigger> = new Map([
  ['manual', 'manual'],
  ['auto', 'auto'],
])

export const compactionTrigger = (trigger: string | null | undefined): CompactionTrigger =>
  (typeof trigger === 'string' ? compactionTriggers.get(trigger) : undefined) ?? 'unknown'
