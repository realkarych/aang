import type { Fact, FactId, RawSeq, SessionKey, StreamKey } from '@aang/contract'
import type { Transaction } from '@aang/store'
import { agentKey, byContent, compareText, type Evidence, ofKind } from './evidence.js'

export interface ForkOrigin {
  readonly session: SessionKey
  readonly fact: FactId
}

export interface Lineage {
  readonly inherited: ReadonlySet<RawSeq>
  readonly markers: readonly FactId[]
  readonly forkedFrom: ForkOrigin | null
}

interface CopiedBlock {
  readonly launch: Fact | null
  readonly records: ReadonlySet<RawSeq>
}

const pageSize = 64

const noBlock: CopiedBlock = { launch: null, records: new Set() }

const transcriptStream = (key: SessionKey, items: readonly Evidence[]): StreamKey | null =>
  key.runtime === 'claude'
    ? (items.find(({ fact, raw }) => raw.channel === 'transcript' && agentKey(fact).agent.kind === 'main')?.raw
        .stream ?? null)
    : null

const queueFacts = (items: readonly Evidence[]): Map<RawSeq, Fact> => {
  const queued = new Map<RawSeq, Fact>()
  for (const { fact, raw } of ofKind(items, 'queue_operation')) {
    if (!queued.has(raw.seq)) {
      queued.set(raw.seq, fact)
    }
  }
  return queued
}

const copiedBlock = (transaction: Transaction, stream: StreamKey, queued: ReadonlyMap<RawSeq, Fact>): CopiedBlock => {
  let launch: Fact | null = null
  const records = new Set<RawSeq>()
  let after: RawSeq | null = null
  for (;;) {
    const page = transaction.rawRecords.ofStream(stream, after, pageSize)
    if (page.length === 0) {
      return records.size === 0 ? noBlock : { launch, records }
    }
    for (const raw of page) {
      after = raw.seq
      const opening = records.size === 0 ? queued.get(raw.seq) : undefined
      if (opening !== undefined) {
        launch ??= opening
      } else if (raw.source_ts !== null) {
        if (launch === null || raw.source_ts >= launch.at) {
          return records.size === 0 ? noBlock : { launch, records }
        }
        records.add(raw.seq)
      }
    }
  }
}

export const lineageOf = (transaction: Transaction, key: SessionKey, items: readonly Evidence[]): Lineage => {
  const stream = transcriptStream(key, items)
  const block = stream === null ? noBlock : copiedBlock(transaction, stream, queueFacts(items))
  const starts = ofKind(items, 'session_start').toSorted(byContent)
  const origin = starts.find(({ fact }) => fact.payload.forked_from !== null)?.fact
  const forkedFrom = origin?.payload.forked_from ?? null
  return {
    inherited: block.records,
    markers: [
      ...new Set([
        ...starts.flatMap(({ fact }) => (fact.payload.launch === 'fork' ? [fact.id] : [])),
        ...(block.launch === null ? [] : [block.launch.id]),
      ]),
    ].sort(compareText),
    forkedFrom:
      origin === undefined || forkedFrom === null
        ? null
        : { session: { kind: 'session', runtime: key.runtime, session: forkedFrom.session }, fact: origin.id },
  }
}

export const isFork = (lineage: Lineage): boolean => lineage.markers.length > 0

export const isInherited =
  (lineage: Lineage) =>
  ({ raw }: Evidence): boolean =>
    lineage.inherited.has(raw.seq)
