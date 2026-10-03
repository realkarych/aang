import {
  ActionId,
  type ArtifactRef,
  type ArtifactVersionKey,
  ChangeSeq,
  DedupeKey,
  EpochNs,
  FactId,
  type GitSnapshotKey,
  RunId,
} from '@aang/contract'
import { contentHash, objectId } from '@aang/contract/ids'
import type { ArtifactVersionDraft, GitSnapshotDraft, Store } from '@aang/store'
import { expect, test } from 'vitest'
import { createHome } from './home.js'

const run = RunId.parse('a'.repeat(32))
const action = ActionId.parse('b'.repeat(32))
const fact = FactId.parse('c'.repeat(32))
const at = EpochNs.parse(1_759_370_000_000_000_000n)

const versionOf = (path: string, identity: ArtifactVersionKey['identity'] = { kind: 'reference', fact }): ArtifactVersionDraft => {
  const ref: ArtifactRef = { kind: 'file', path }
  const key: ArtifactVersionKey = { kind: 'artifact_version', run, artifact: ref, identity }
  return {
    id: objectId(key),
    key,
    run,
    artifact: objectId({ kind: 'artifact', run, artifact: ref }),
    ref,
    retention: { kind: 'reference' },
    produced_by: action,
    observed_at: at,
  }
}

const snapshotOf = (record: string): GitSnapshotDraft => {
  const key: GitSnapshotKey = { kind: 'git_snapshot', record: DedupeKey.parse(record) }
  return {
    id: objectId(key),
    key,
    run,
    worktree: '/work',
    trigger: 'check',
    masks: ['src'],
    head: 'f'.repeat(40),
    clean: true,
    taken_at: at,
    fact,
  }
}

const isStored = (store: Store, text: string): boolean => store.artifacts.blob(contentHash(text)) !== null

test('versions and snapshots are saved idempotently, listed by run and published in the change feed', async ({ onTestFinished }) => {
  const home = await createHome(onTestFinished)
  const store = home.open()
  const report = versionOf('/work/report.md')
  const snapshot = snapshotOf('snapshot:1')
  const [savedVersion, savedSnapshot, repeated] = store.transaction((transaction) => [
    transaction.artifacts.saveVersion(report),
    transaction.artifacts.saveSnapshot(snapshot),
    transaction.artifacts.saveVersion(report),
  ])
  expect(repeated).toEqual(savedVersion)
  expect(store.artifacts.versions(run)).toEqual([savedVersion])
  expect(store.artifacts.snapshots(run)).toEqual([savedSnapshot])
  expect(store.artifacts.getSnapshot(snapshot.id)).toEqual(savedSnapshot)
  expect(store.artifacts.unretained()).toEqual([savedVersion])
  expect(store.changes.after(ChangeSeq.parse(0), 10)).toEqual([
    { layer: 'object', change_seq: savedVersion.change_seq, object: savedVersion },
    { layer: 'object', change_seq: savedSnapshot.change_seq, object: savedSnapshot },
  ])
})

test('retained contents are stored once by hash and released with their last reference', async ({ onTestFinished }) => {
  const home = await createHome(onTestFinished)
  const store = home.open()
  const first = versionOf('/work/a.md')
  const second = versionOf('/work/b.md', { kind: 'content', hash: contentHash('same') })
  const large = versionOf('/work/large.bin')
  const content = new TextEncoder().encode('same')
  const retained = store.transaction((transaction) => {
    for (const draft of [first, second, large]) {
      transaction.artifacts.saveVersion(draft)
    }
    return [
      transaction.artifacts.retain(first.id, { kind: 'file_read', read_at: at, content }),
      transaction.artifacts.retain(second.id, { kind: 'action_payload', action, content }),
      transaction.artifacts.retain(large.id, { kind: 'hash_only', content_hash: contentHash('large'), size_bytes: 5 }),
    ]
  })
  expect(retained.map(({ retention }) => retention)).toEqual([
    { kind: 'file_read', blob: contentHash('same'), read_at: at },
    { kind: 'action_payload', blob: contentHash('same'), action },
    { kind: 'hash_only', content_hash: contentHash('large'), size_bytes: 5 },
  ])
  expect(store.artifacts.unretained()).toEqual([])
  expect(store.artifacts.blob(contentHash('same'))).toEqual(content)
  const database = home.database()
  const select = database.prepare('SELECT source, read_at FROM blob_refs ORDER BY source')
  select.setReadBigInts(true)
  const refs = select.all()
  expect(refs).toEqual([
    { source: 'action_payload', read_at: null },
    { source: 'file_read', read_at: at },
  ])
  database.prepare('DELETE FROM blob_refs WHERE version_id = ?').run(first.id)
  expect(isStored(store, 'same')).toBe(true)
  database.prepare('DELETE FROM blob_refs WHERE version_id = ?').run(second.id)
  expect(isStored(store, 'same')).toBe(false)
})

test('mismatched keys and repeated or unknown retention are rejected', async ({ onTestFinished }) => {
  const home = await createHome(onTestFinished)
  const store = home.open()
  const report = versionOf('/work/report.md')
  const content = new TextEncoder().encode('report')
  const attempt = (work: Parameters<Store['transaction']>[0]) => () => store.transaction(work)
  expect(attempt((transaction) => transaction.artifacts.saveVersion({ ...report, id: versionOf('/work/other.md').id }))).toThrow(
    'artifact version id or run does not match its key',
  )
  expect(attempt((transaction) => transaction.artifacts.saveVersion({ ...report, run: RunId.parse('d'.repeat(32)) }))).toThrow(
    'artifact version id or run does not match its key',
  )
  expect(attempt((transaction) => transaction.artifacts.saveVersion({ ...report, ref: { kind: 'url', url: 'https://example.invalid' } }))).toThrow(
    'artifact version does not belong to its artifact',
  )
  expect(attempt((transaction) => transaction.artifacts.saveSnapshot({ ...snapshotOf('snapshot:1'), id: snapshotOf('snapshot:2').id }))).toThrow(
    'git snapshot id does not match its key',
  )
  expect(attempt((transaction) => transaction.artifacts.retain(report.id, { kind: 'file_read', read_at: at, content }))).toThrow(
    `unknown artifact version ${report.id}`,
  )
  store.transaction((transaction) => {
    transaction.artifacts.saveVersion(report)
    transaction.artifacts.retain(report.id, { kind: 'file_read', read_at: at, content })
  })
  expect(attempt((transaction) => transaction.artifacts.retain(report.id, { kind: 'file_read', read_at: at, content }))).toThrow(
    `artifact version ${report.id} is already retained`,
  )
  expect(store.artifacts.getVersion(report.id)?.retention).toEqual({ kind: 'file_read', blob: contentHash('report'), read_at: at })
})
