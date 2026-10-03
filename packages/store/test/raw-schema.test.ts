import type { DatabaseSync } from 'node:sqlite'
import { beforeAll, expect, test } from 'vitest'
import { checkSchemaCase, createSchemaDatabase, insert, type Row, type SchemaCase } from './home.js'

const stream: Row = {
  stream: "'claude:s1:main'",
  runtime: "'claude'",
  scope: "'watched'",
}

const sessionScope: Row = {
  runtime: "'claude'",
  session: "'s1'",
  scope: "'watched'",
}

const rawRecord: Row = {
  dedupe_key: "'claude:s1:u1'",
  channel: "'transcript'",
  runtime: "'claude'",
  stream: "'claude:s1:main'",
  position: '\'{"kind":"line","path":"/p/s1.jsonl","offset":0,"line":1}\'',
  hook: 'NULL',
  observed_at: '1759370000123456789',
  source_ts: '1759370000000000000',
  payload: "x'7b7d'",
  parse_state: "'parsed'",
  change_seq: '1',
}

const fact: Row = {
  id: "'f1'",
  seq: '1',
  record_index: '0',
  kind: "'message'",
  entity_key: '\'{"kind":"message","message":"m1","runtime":"claude","session":"s1"}\'',
  speaker: "'solver'",
  urgent: '0',
  occurred_at: '1759370000000000000',
  runtime_ids: "'{}'",
  runtime_env: "'{}'",
  format_verified: '1',
  redelivery_key: 'NULL',
  payload: "'{}'",
  normalizer_version: '1',
  change_seq: '1',
}

const cursor: Row = {
  path: "'/home/u/.claude/projects/p/s1.jsonl'",
  stream: "'claude:s1:main'",
  dev: "'16777232'",
  inode: "'91234567'",
  byte_offset: '120',
  line_number: '2',
  size: '120',
  last_ordinal: 'NULL',
}

const gap: Row = {
  id: "'g1'",
  entity_key: '\'{"gap":"source_lost","kind":"gap","subject":"claude:s1:main"}\'',
  kind: "'source_lost'",
  run_id: 'NULL',
  session_id: 'NULL',
  stream: "'claude:s1:main'",
  details: 'NULL',
  detected_at: '1759370000000000000',
  closed_at: 'NULL',
  change_seq: '1',
}

const claudeBoundary: Row = {
  stream: "'claude:s1:main'",
  runtime: "'claude'",
  session: "'s1'",
  last_ordinal: 'NULL',
  byte_offset: '120',
  prefix_hash: "'sha256:ab'",
  pruned_at: '1759370000000000000',
}

const codexBoundary: Row = {
  stream: "'codex:t1'",
  runtime: "'codex'",
  session: "'t1'",
  last_ordinal: '41',
  byte_offset: 'NULL',
  prefix_hash: 'NULL',
  pruned_at: '1759370000000000000',
}

let database: DatabaseSync

beforeAll(async () => {
  const schema = await createSchemaDatabase()
  database = schema.database
  database.exec([insert('streams', stream), insert('raw_records', rawRecord), insert('facts', fact)].join('; '))
  return schema.dispose
})

const cases: readonly SchemaCase[] = [
  {
    name: 'a raw record from a runtime channel is accepted',
    statement: insert('raw_records', rawRecord, { dedupe_key: "'claude:s1:u2'", change_seq: '2' }),
  },
  {
    name: 'a raw record written by the daemon itself needs no runtime',
    statement: insert('raw_records', rawRecord, {
      dedupe_key: "'snapshot:r1:1'",
      channel: "'snapshot'",
      runtime: 'NULL',
      stream: 'NULL',
      position: '\'{"kind":"daemon"}\'',
      source_ts: 'NULL',
    }),
  },
  {
    name: 'a hook record carries its registration envelope and may have no stream yet',
    statement: insert('raw_records', rawRecord, {
      dedupe_key: "'hook:1759370000123-4242-a1.evt'",
      channel: "'hook'",
      stream: 'NULL',
      position: '\'{"kind":"spool","file":"1759370000123-4242-a1.evt"}\'',
      hook: '\'{"registration":"plugin","env":{}}\'',
    }),
  },
  {
    name: 'a registration envelope belongs only to records of the hook channel',
    statement: insert('raw_records', rawRecord, { dedupe_key: "'k2'", hook: '\'{"registration":"plugin","env":{}}\'' }),
    error: /CHECK constraint failed: raw_records_hook_channel/,
  },
  {
    name: 'a registration envelope must be JSON',
    statement: insert('raw_records', rawRecord, { dedupe_key: "'k2'", channel: "'hook'", hook: "'plugin'" }),
    error: /CHECK constraint failed: json_valid\(hook\)/,
  },
  {
    name: 'a raw record without a position is rejected',
    statement: insert('raw_records', rawRecord, { dedupe_key: "'k2'", position: 'NULL' }),
    error: /NOT NULL constraint failed: raw_records\.position/,
  },
  {
    name: 'a second raw record with the same dedupe key is rejected',
    statement: insert('raw_records', rawRecord, { change_seq: '2' }),
    error: /UNIQUE constraint failed: raw_records\.dedupe_key/,
  },
  {
    name: 'a raw record from an unknown channel is rejected',
    statement: insert('raw_records', rawRecord, { dedupe_key: "'k2'", channel: "'stdout'" }),
    error: /CHECK constraint failed: channel IN/,
  },
  {
    name: 'a raw record from a runtime channel without a runtime is rejected',
    statement: insert('raw_records', rawRecord, { dedupe_key: "'k2'", runtime: 'NULL' }),
    error: /CHECK constraint failed: raw_records_runtime_channel/,
  },
  {
    name: 'a raw record from an unknown runtime is rejected',
    statement: insert('raw_records', rawRecord, { dedupe_key: "'k2'", runtime: "'gemini'" }),
    error: /CHECK constraint failed: runtime IN/,
  },
  {
    name: 'a raw record with an unknown parse state is rejected',
    statement: insert('raw_records', rawRecord, { dedupe_key: "'k2'", parse_state: "'broken'" }),
    error: /CHECK constraint failed: parse_state IN/,
  },
  {
    name: 'a raw record payload must be stored as bytes',
    statement: insert('raw_records', rawRecord, { dedupe_key: "'k2'", payload: "'{}'" }),
    error: /cannot store TEXT value in BLOB column raw_records\.payload/,
  },
  {
    name: 'a raw record position must be JSON',
    statement: insert('raw_records', rawRecord, { dedupe_key: "'k2'", position: "'line 1'" }),
    error: /CHECK constraint failed: json_valid\(position\)/,
  },
  {
    name: 'a raw record without an issued change sequence number is rejected',
    statement: insert('raw_records', rawRecord, { dedupe_key: "'k2'", change_seq: '0' }),
    error: /CHECK constraint failed: change_seq > 0/,
  },
  {
    name: 'a further fact of a raw record is accepted at the next position',
    statement: insert('facts', fact, { id: "'f2'", record_index: '1' }),
  },
  {
    name: 'a fact must come from a stored raw record',
    statement: insert('facts', fact, { id: "'f2'", seq: '99' }),
    error: /FOREIGN KEY constraint failed/,
  },
  {
    name: 'a fact id is unique',
    statement: insert('facts', fact, { record_index: '1' }),
    error: /UNIQUE constraint failed: facts\.id/,
  },
  {
    name: 'a fact taking the position of another fact of its raw record is rejected',
    statement: insert('facts', fact, { id: "'f2'" }),
    error: /UNIQUE constraint failed: facts\.seq, facts\.record_index/,
  },
  {
    name: 'a fact with an unknown speaker is rejected',
    statement: insert('facts', fact, { id: "'f2'", record_index: '1', speaker: "'assistant'" }),
    error: /CHECK constraint failed: speaker IN/,
  },
  {
    name: 'a fact urgency is a boolean',
    statement: insert('facts', fact, { id: "'f2'", record_index: '1', urgent: '2' }),
    error: /CHECK constraint failed: urgent IN/,
  },
  {
    name: 'a fact format verification is a boolean',
    statement: insert('facts', fact, { id: "'f2'", record_index: '1', format_verified: '2' }),
    error: /CHECK constraint failed: format_verified IN/,
  },
  {
    name: 'a fact entity key must be JSON',
    statement: insert('facts', fact, { id: "'f2'", record_index: '1', entity_key: "'claude:s1:m1'" }),
    error: /CHECK constraint failed: json_valid\(entity_key\)/,
  },
  {
    name: 'a fact payload must be JSON',
    statement: insert('facts', fact, { id: "'f2'", record_index: '1', payload: "'{'" }),
    error: /CHECK constraint failed: json_valid\(payload\)/,
  },
  {
    name: 'a fact normalizer version is a positive number',
    statement: insert('facts', fact, { id: "'f2'", record_index: '1', normalizer_version: '0' }),
    error: /CHECK constraint failed: normalizer_version > 0/,
  },
  {
    name: 'a stream scope decision is watched, external or observer',
    statement: insert('streams', stream, { stream: "'claude:s2:main'", scope: "'included'" }),
    error: /CHECK constraint failed: scope IN/,
  },
  {
    name: 'a root session scope decision is accepted',
    statement: insert('session_scopes', sessionScope),
  },
  {
    name: 'a root session scope decision is watched, external or observer',
    statement: insert('session_scopes', sessionScope, { scope: "'included'" }),
    error: /CHECK constraint failed: scope IN/,
  },
  {
    name: 'a root session scope decision belongs to a known runtime',
    statement: insert('session_scopes', sessionScope, { runtime: "'gemini'" }),
    error: /CHECK constraint failed: runtime IN/,
  },
  {
    name: 'a root session scope decision names the session',
    statement: insert('session_scopes', sessionScope, { session: "''" }),
    error: /CHECK constraint failed: session <> ''/,
  },
  {
    name: 'a root session has a single scope decision per runtime',
    setup: [insert('session_scopes', sessionScope)],
    statement: insert('session_scopes', sessionScope, { scope: "'external'" }),
    error: /UNIQUE constraint failed: session_scopes\.runtime, session_scopes\.session/,
  },
  {
    name: 'a root session scope decision keeps the starting directory it was judged by',
    statement: insert('session_scopes', sessionScope, { cwd: "'/work/project'" }),
  },
  {
    name: 'a root session scope decision does not keep an empty starting directory',
    statement: insert('session_scopes', sessionScope, { cwd: "''" }),
    error: /CHECK constraint failed: cwd <> ''/,
  },
  {
    name: 'sessions of different runtimes with the same id are decided separately',
    setup: [insert('session_scopes', sessionScope)],
    statement: insert('session_scopes', sessionScope, { runtime: "'codex'", scope: "'external'" }),
  },
  {
    name: 'a cursor holding 64-bit unsigned device and inode numbers is accepted',
    statement: insert('cursors', cursor, { dev: "'18446744073709551615'", inode: "'18446744073709551615'" }),
  },
  {
    name: 'a cursor of a file whose stream is not known yet is accepted',
    statement: insert('cursors', cursor, { stream: 'NULL' }),
  },
  {
    name: 'a cursor must belong to a stream with a scope decision',
    statement: insert('cursors', cursor, { stream: "'claude:s2:main'" }),
    error: /FOREIGN KEY constraint failed/,
  },
  {
    name: 'a cursor device number is a decimal string',
    statement: insert('cursors', cursor, { dev: "'0x1000010'" }),
    error: /CHECK constraint failed: dev <> '' AND dev NOT GLOB/,
  },
  {
    name: 'a cursor inode number is a decimal string',
    statement: insert('cursors', cursor, { inode: "''" }),
    error: /CHECK constraint failed: inode <> '' AND inode NOT GLOB/,
  },
  {
    name: 'a cursor cannot point past the size of the file',
    statement: insert('cursors', cursor, { byte_offset: '121' }),
    error: /CHECK constraint failed: size >= byte_offset/,
  },
  {
    name: 'a cursor line number cannot be negative',
    statement: insert('cursors', cursor, { line_number: '-1' }),
    error: /CHECK constraint failed: line_number >= 0/,
  },
  {
    name: 'a gap with no run, session or stream is accepted',
    statement: insert('gaps', gap, { stream: 'NULL' }),
  },
  {
    name: 'a gap has a single row per id',
    setup: [insert('gaps', gap)],
    statement: insert('gaps', gap, { change_seq: '2' }),
    error: /UNIQUE constraint failed: gaps\.id/,
  },
  {
    name: 'a gap key must be JSON',
    statement: insert('gaps', gap, { entity_key: "'source_lost:claude:s1:main'" }),
    error: /CHECK constraint failed: json_valid\(entity_key\)/,
  },
  {
    name: 'a gap cannot close before it was detected',
    statement: insert('gaps', gap, { closed_at: '1759369999999999999' }),
    error: /CHECK constraint failed: closed_at >= detected_at/,
  },
  {
    name: 'a Claude prune boundary is an offset with a prefix hash',
    statement: insert('pruned_streams', claudeBoundary),
  },
  {
    name: 'a Codex prune boundary is the last ordinal',
    statement: insert('pruned_streams', codexBoundary),
  },
  {
    name: 'a Claude prune boundary without a prefix hash is rejected',
    statement: insert('pruned_streams', claudeBoundary, { prefix_hash: 'NULL' }),
    error: /CHECK constraint failed: pruned_streams_boundary/,
  },
  {
    name: 'a Codex prune boundary with a byte offset is rejected',
    statement: insert('pruned_streams', codexBoundary, { byte_offset: '120' }),
    error: /CHECK constraint failed: pruned_streams_boundary/,
  },
  {
    name: 'a prune boundary names the root session of its stream',
    statement: insert('pruned_streams', codexBoundary, { session: "''" }),
    error: /CHECK constraint failed: session <> ''/,
  },
  {
    name: 'a stream has a single prune boundary',
    setup: [insert('pruned_streams', claudeBoundary)],
    statement: insert('pruned_streams', claudeBoundary, { byte_offset: '240' }),
    error: /UNIQUE constraint failed: pruned_streams\.stream/,
  },
]

test.for(cases)('$name', (schemaCase) => {
  checkSchemaCase(database, schemaCase)
})

test('raw record sequence numbers are not reused after the newest record is deleted', () => {
  database.exec('SAVEPOINT reuse')
  database.exec(insert('raw_records', rawRecord, { dedupe_key: "'claude:s1:u2'" }))
  const deleted = database.prepare('DELETE FROM raw_records WHERE dedupe_key = ? RETURNING seq').get('claude:s1:u2')
  database.exec(insert('raw_records', rawRecord, { dedupe_key: "'claude:s1:u3'" }))
  const next = database.prepare('SELECT seq FROM raw_records WHERE dedupe_key = ?').get('claude:s1:u3')
  database.exec('ROLLBACK TO reuse; RELEASE reuse')

  expect(deleted).toEqual({ seq: 2 })
  expect(next).toEqual({ seq: 3 })
})

test('deleting a raw record deletes the facts derived from it', () => {
  database.exec('SAVEPOINT prune')
  database.exec("DELETE FROM raw_records WHERE dedupe_key = 'claude:s1:u1'")
  const remaining = database.prepare('SELECT count(*) AS facts FROM facts').get()
  database.exec('ROLLBACK TO prune; RELEASE prune')

  expect(remaining).toEqual({ facts: 0 })
})
