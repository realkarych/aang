import { readFileSync } from 'node:fs'
import { CollectedRecord } from '@aang/contract'

interface OtelSample {
  readonly _case: string
  readonly logRecord?: {
    readonly attributes: { readonly key: string; readonly value: { readonly stringValue: string } }[]
  }
}

export const otelThread = 'otel-child'
export const otelRoot = 'otel-root'
export const otelCall = 'otel-command'

export const decisionRecord = (thread = otelThread): CollectedRecord => {
  const variants = readFileSync(
    new URL('../../../docs/research/samples/codex-otel/logs.tool_decision.variants.jsonl', import.meta.url),
    'utf8',
  )
    .split('\n')
    .filter(Boolean)
    .map((line): OtelSample => JSON.parse(line) as OtelSample)
  const log = variants.find((value) => value._case === 'codex exec subagent thread')?.logRecord
  if (log === undefined) {
    throw new Error('missing subagent OTel sample')
  }
  const replacements: Readonly<Record<string, string>> = {
    'conversation.id': thread,
    call_id: otelCall,
    source: 'User',
  }
  const attributes = log.attributes.map((attribute) => ({
    ...attribute,
    value: { stringValue: replacements[attribute.key] ?? attribute.value.stringValue },
  }))
  return CollectedRecord.parse({
    channel: 'otel',
    runtime: 'codex',
    stream: null,
    position: { kind: 'otel' },
    hook: null,
    observed_at: 1_790_856_592_228_739_000n,
    payload: JSON.stringify({ ...log, attributes }),
  })
}
