import type { DatabaseSync } from 'node:sqlite'
import { beforeAll, expect, test } from 'vitest'
import { checkSchemaCase, createSchemaDatabase, insert, type Row, type SchemaCase } from './home.js'

const stream: Row = {
  stream: "'claude:s1:main'",
  runtime: "'claude'",
  coverage: "'included'",
  decided_at: '1759370000000000000',
}

const rawRecord: Row = {
  dedupe_key: "'claude:s1:u1'",
  channel: "'transcript'",
  runtime: "'claude'",
  stream: "'claude:s1:main'",
  position: '\'{"offset":0,"line":1}\'',
  observed_at: '1759370000123456789',
  source_ts: '1759370000000000000',
  payload: "x'7b7d'",
  parse_state: "'parsed'",
  change_seq: '1',
}

const fact: Row = {
  id: "'f1'",
  seq: '1',
  kind: "'message'",
  entity_key: "'claude:s1:u1'",
  ordinal: '0',
  speaker: "'solver'",
  urgent: '0',
  runtime: "'claude'",
  runtime_session_id: "'s1'",
  runtime_agent_id: 'NULL',
  occurred_at: '1759370000000000000',
  payload: "'{}'",
  normalizer_version: "'1'",
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
  updated_at: '1759370000000000000',
}

const gap: Row = {
  kind: "'source_lost'",
  runtime: "'claude'",
  stream: "'claude:s1:main'",
  run_id: 'NULL',
  detail: "'{}'",
  observed_at: '1759370000000000000',
  change_seq: '1',
}

const claudeBoundary: Row = {
  stream: "'claude:s1:main'",
  runtime: "'claude'",
  last_ordinal: 'NULL',
  byte_offset: '120',
  prefix_hash: "'sha256:ab'",
  pruned_at: '1759370000000000000',
}

const codexBoundary: Row = {
  stream: "'codex:t1'",
  runtime: "'codex'",
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
      stream: "'run:r1'",
      position: 'NULL',
      source_ts: 'NULL',
    }),
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
    name: 'a further fact of the same kind and entity in a raw record is accepted',
    statement: insert('facts', fact, { id: "'f2'", ordinal: '1' }),
  },
  {
    name: 'a fact must come from a stored raw record',
    statement: insert('facts', fact, { id: "'f2'", seq: '99' }),
    error: /FOREIGN KEY constraint failed/,
  },
  {
    name: 'a fact id is unique',
    statement: insert('facts', fact, { ordinal: '1' }),
    error: /UNIQUE constraint failed: facts\.id/,
  },
  {
    name: 'a fact repeating the kind, entity and ordinal of its raw record is rejected',
    statement: insert('facts', fact, { id: "'f2'" }),
    error: /UNIQUE constraint failed: facts\.seq, facts\.kind, facts\.entity_key, facts\.ordinal/,
  },
  {
    name: 'a fact with an unknown speaker is rejected',
    statement: insert('facts', fact, { id: "'f2'", ordinal: '1', speaker: "'assistant'" }),
    error: /CHECK constraint failed: speaker IN/,
  },
  {
    name: 'a fact urgency is a boolean',
    statement: insert('facts', fact, { id: "'f2'", ordinal: '1', urgent: '2' }),
    error: /CHECK constraint failed: urgent IN/,
  },
  {
    name: 'a fact payload must be JSON',
    statement: insert('facts', fact, { id: "'f2'", ordinal: '1', payload: "'{'" }),
    error: /CHECK constraint failed: json_valid\(payload\)/,
  },
  {
    name: 'a stream coverage decision is either included or excluded',
    statement: insert('streams', stream, { stream: "'claude:s2:main'", coverage: "'unknown'" }),
    error: /CHECK constraint failed: coverage IN/,
  },
  {
    name: 'a cursor holding 64-bit unsigned device and inode numbers is accepted',
    statement: insert('cursors', cursor, { dev: "'18446744073709551615'", inode: "'18446744073709551615'" }),
  },
  {
    name: 'a cursor must belong to a stream with a coverage decision',
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
    name: 'a gap with no stream is accepted',
    statement: insert('gaps', gap, { runtime: 'NULL', stream: 'NULL' }),
  },
  {
    name: 'a gap detail must be JSON',
    statement: insert('gaps', gap, { detail: "'lost'" }),
    error: /CHECK constraint failed: json_valid\(detail\)/,
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
