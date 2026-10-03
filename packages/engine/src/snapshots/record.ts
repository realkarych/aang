import { DedupeKey, NormalizerVersion } from '@aang/contract'
import { canonicalJson, contentHash, objectId } from '@aang/contract/ids'
import type { Transaction } from '@aang/store'
import type { TakenSnapshot } from './take.js'

const daemonNormalizer = NormalizerVersion.parse(1)

const noRuntimeIds = {
  session_id: null,
  agent_id: null,
  thread_id: null,
  turn_id: null,
  prompt_id: null,
  record_uuid: null,
  parent_uuid: null,
  message_id: null,
  call_id: null,
  ordinal: null,
}

const dedupeKeyOf = ({ request, payload, at }: TakenSnapshot): DedupeKey =>
  DedupeKey.parse(
    `snapshot:${contentHash(canonicalJson([request.run, payload.worktree, payload.trigger, payload.masks, at.toString()]))}`,
  )

export const recordSnapshot = (transaction: Transaction, taken: TakenSnapshot): void => {
  const { request, payload, at } = taken
  const dedupeKey = dedupeKeyOf(taken)
  const { seq } = transaction.rawRecords.insert({
    dedupe_key: dedupeKey,
    channel: 'snapshot',
    runtime: null,
    stream: null,
    position: { kind: 'daemon' },
    hook: null,
    observed_at: at,
    source_ts: at,
    payload: JSON.stringify(payload),
    parse_state: 'parsed',
  })
  const facts = transaction.facts.insert(seq, daemonNormalizer, [
    {
      kind: 'git_snapshot',
      entity_key: { kind: 'run', runtime: request.root.runtime, session: request.root.session },
      speaker: 'runtime',
      urgent: false,
      at,
      runtime_ids: noRuntimeIds,
      runtime_env: { cwd: payload.worktree, version: null, entrypoint: null, originator: null, git_branch: null },
      format_verified: true,
      redelivery_key: null,
      payload,
    },
  ])
  const key = { kind: 'git_snapshot', record: dedupeKey } as const
  for (const fact of facts) {
    transaction.artifacts.saveSnapshot({
      id: objectId(key),
      key,
      run: request.run,
      worktree: payload.worktree,
      trigger: payload.trigger,
      masks: payload.masks,
      head: payload.head,
      clean: payload.clean,
      taken_at: at,
      fact: fact.id,
    })
  }
}
