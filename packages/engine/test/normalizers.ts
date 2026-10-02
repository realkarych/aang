import { claudeAdapter } from '@aang/adapter-claude'
import { codexAdapter } from '@aang/adapter-codex'
import {
  type Adapter,
  type AdapterRegistry,
  type CollectedRecord,
  type FactDraft,
  type FactKind,
  NormalizerVersion,
  type ParseResult,
  type RawChannel,
  type Runtime,
} from '@aang/contract'
import { canonicalJson } from '@aang/contract/ids'

export type Revision = (result: ParseResult, record: CollectedRecord) => ParseResult

const nextNormalizer = (adapter: Adapter, version: NormalizerVersion, revise: Revision): Adapter => ({
  runtime: adapter.runtime,
  normalizerVersion: version,
  streamKey: (lines) => adapter.streamKey(lines),
  rawKey: (record) => adapter.rawKey(record),
  owner: (record) => adapter.owner(record),
  parse: (record) => revise(adapter.parse(record), record),
})

export const nextNormalizers = (version: number, ...revisions: readonly Revision[]): AdapterRegistry =>
  new Map<Runtime, Adapter>(
    [claudeAdapter, codexAdapter].map((adapter) => [
      adapter.runtime,
      nextNormalizer(adapter, NormalizerVersion.parse(version), (result, record) =>
        revisions.reduce((revised, revise) => revise(revised, record), result),
      ),
    ]),
  )

const revisedFacts =
  (revise: (facts: readonly FactDraft[]) => FactDraft[]): Revision =>
  (result) =>
    result.parse_state === 'parsed' ? { ...result, facts: revise(result.facts) } : result

export const reversedFactGroups: Revision = revisedFacts((facts) => {
  const groups = new Map<string, FactDraft[]>()
  for (const fact of facts) {
    const group = canonicalJson([fact.kind, fact.entity_key])
    groups.set(group, [...(groups.get(group) ?? []), fact])
  }
  return [...groups.values()].reverse().flat()
})

export const withoutFacts = (kind: FactKind): Revision =>
  revisedFacts((facts) => facts.filter((fact) => fact.kind !== kind))

export const invalidChannel =
  (channel: RawChannel): Revision =>
  (result, record) =>
    record.channel === channel ? { parse_state: 'invalid', reason: `the next normalizer rejects ${channel}` } : result

export const failingAt =
  (line: number): Revision =>
  (result, record) => {
    if (record.position.kind === 'line' && record.position.line === line) {
      throw new Error(`the next normalizer fails at line ${String(line)}`)
    }
    return result
  }
