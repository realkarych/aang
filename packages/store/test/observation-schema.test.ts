import type { DatabaseSync } from 'node:sqlite'
import { beforeAll, expect, test } from 'vitest'
import { checkSchemaCase, createSchemaDatabase, insert, type Row, type SchemaCase } from './home.js'

const run: Row = {
  id: "'r1'",
  root_session_key: "'claude:s1'",
  runtime: "'claude'",
  data: "'{}'",
  change_seq: '1',
}

const object: Row = {
  id: "'o1'",
  kind: "'session'",
  entity_key: "'claude:s1'",
  run_id: "'r1'",
  data: "'{}'",
  change_seq: '1',
}

const removal: Row = {
  id: "'o3'",
  kind: "'agent'",
  entity_key: "'claude:s1:a7'",
  run_id: "'r1'",
  replaced_by: "'o4'",
  change_seq: '2',
}

const link: Row = {
  kind: "'spawned'",
  from_id: "'o1'",
  to_id: "'o2'",
  basis: "'observed'",
  interpreter: 'NULL',
  evidence: '\'["f1"]\'',
  change_seq: '1',
}

const binding: Row = {
  kind: "'attach'",
  session_id: "'o3'",
  target_run_id: "'r1'",
  created_at: '1759370000000000000',
  revoked_at: 'NULL',
  change_seq: '1',
}

const blobRef: Row = {
  hash: "'sha256:aa'",
  version_id: "'v1'",
  source: "'action_payload'",
  read_at: 'NULL',
}

let database: DatabaseSync

beforeAll(async () => {
  const schema = await createSchemaDatabase()
  database = schema.database
  database.exec(
    [
      insert('runs', run),
      insert('objects', object),
      insert('object_removals', removal),
      insert('links', link),
      "INSERT INTO blobs (hash, content) VALUES ('sha256:aa', x'6869')",
    ].join('; '),
  )
  return schema.dispose
})

const cases: readonly SchemaCase[] = [
  {
    name: 'a run is created once per root session',
    statement: insert('runs', run, { id: "'r2'" }),
    error: /UNIQUE constraint failed: runs\.root_session_key/,
  },
  {
    name: 'a run of an unknown runtime is rejected',
    statement: insert('runs', run, { id: "'r2'", root_session_key: "'gemini:s1'", runtime: "'gemini'" }),
    error: /CHECK constraint failed: runtime IN/,
  },
  {
    name: 'a run description must be JSON',
    statement: insert('runs', run, { id: "'r2'", root_session_key: "'claude:s2'", data: "'goal'" }),
    error: /CHECK constraint failed: json_valid\(data\)/,
  },
  {
    name: 'an observation object not yet linked to a run is accepted',
    statement: insert('objects', object, { id: "'o2'", entity_key: "'claude:s2'", run_id: 'NULL' }),
  },
  {
    name: 'objects of different kinds may share an entity key',
    statement: insert('objects', object, { id: "'o2'", kind: "'agent'" }),
  },
  {
    name: 'an observation object is unique per kind and entity key',
    statement: insert('objects', object, { id: "'o2'" }),
    error: /UNIQUE constraint failed: objects\.kind, objects\.entity_key/,
  },
  {
    name: 'observation object attributes must be JSON',
    statement: insert('objects', object, { id: "'o2'", kind: "'agent'", data: "'main'" }),
    error: /CHECK constraint failed: json_valid\(data\)/,
  },
  {
    name: 'an artifact version keeps the position at which it was first stored',
    statement: insert('objects', object, { id: "'o2'", kind: "'artifact_version'", change_seq: '3', created_seq: '2' }),
  },
  {
    name: 'an artifact version without the position of its creation is rejected',
    statement: insert('objects', object, { id: "'o2'", kind: "'artifact_version'" }),
    error: /CHECK constraint failed: objects_version_created/,
  },
  {
    name: 'only an artifact version keeps the position of its creation',
    statement: insert('objects', object, { id: "'o2'", kind: "'agent'", created_seq: '1' }),
    error: /CHECK constraint failed: objects_version_created/,
  },
  {
    name: 'an artifact version is created no later than its last change',
    statement: insert('objects', object, { id: "'o2'", kind: "'artifact_version'", change_seq: '2', created_seq: '3' }),
    error: /CHECK constraint failed: objects_created_before_changed/,
  },
  {
    name: 'a removed agent not linked to a run is accepted',
    statement: insert('object_removals', removal, { id: "'o5'", entity_key: "'claude:s1:a8'", run_id: 'NULL' }),
  },
  {
    name: 'an object is removed once',
    statement: insert('object_removals', removal, { entity_key: "'claude:s1:a8'" }),
    error: /UNIQUE constraint failed: object_removals\.id/,
  },
  {
    name: 'an object cannot be replaced by itself',
    statement: insert('object_removals', removal, { id: "'o5'", entity_key: "'claude:s1:a8'", replaced_by: "'o5'" }),
    error: /CHECK constraint failed: replaced_by <> id/,
  },
  {
    name: 'only an agent can be removed',
    statement: insert('object_removals', removal, { id: "'o5'", kind: "'session'", entity_key: "'claude:s2'" }),
    error: /CHECK constraint failed: kind IN/,
  },
  {
    name: 'a link interpreted by a rule is accepted',
    statement: insert('links', link, {
      kind: "'permission_for'",
      basis: "'interpreted'",
      interpreter: "'rule:permission-request'",
    }),
  },
  {
    name: 'a link between the same objects is stored once per kind',
    statement: insert('links', link),
    error: /UNIQUE constraint failed: links\.kind, links\.from_id, links\.to_id/,
  },
  {
    name: 'a link with an unknown basis is rejected',
    statement: insert('links', link, { kind: "'forked_from'", basis: "'guessed'" }),
    error: /CHECK constraint failed: basis IN/,
  },
  {
    name: 'an interpreted link must name its interpreter',
    statement: insert('links', link, { kind: "'forked_from'", basis: "'interpreted'" }),
    error: /CHECK constraint failed: links_interpreter/,
  },
  {
    name: 'an interpreter is a rule or an observer call',
    statement: insert('links', link, { kind: "'forked_from'", basis: "'interpreted'", interpreter: "'gpt'" }),
    error: /CHECK constraint failed: links_interpreter/,
  },
  {
    name: 'an observed link has no interpreter',
    statement: insert('links', link, { kind: "'forked_from'", interpreter: "'rule:fork'" }),
    error: /CHECK constraint failed: links_interpreter/,
  },
  {
    name: 'link evidence is a JSON array of fact ids',
    statement: insert('links', link, { kind: "'forked_from'", evidence: '\'{"fact":"f1"}\'' }),
    error: /CHECK constraint failed: json_type\(evidence\)/,
  },
  {
    name: 'a session detached from runs has no target run',
    statement: insert('bindings', binding, { kind: "'detach'", target_run_id: 'NULL' }),
  },
  {
    name: 'a fork parent binding points at a run',
    statement: insert('bindings', binding, { kind: "'fork_parent'" }),
  },
  {
    name: 'an attach binding without a target run is rejected',
    statement: insert('bindings', binding, { target_run_id: 'NULL' }),
    error: /CHECK constraint failed: bindings_target/,
  },
  {
    name: 'a detach binding with a target run is rejected',
    statement: insert('bindings', binding, { kind: "'detach'" }),
    error: /CHECK constraint failed: bindings_target/,
  },
  {
    name: 'a binding of an unknown kind is rejected',
    statement: insert('bindings', binding, { kind: "'merge'" }),
    error: /CHECK constraint failed: kind IN/,
  },
  {
    name: 'a binding cannot be revoked before it was created',
    statement: insert('bindings', binding, { revoked_at: '1759369999999999999' }),
    error: /CHECK constraint failed: revoked_at >= created_at/,
  },
  {
    name: 'a version read from a file records when it was read',
    statement: insert('blob_refs', blobRef, { source: "'file_read'", read_at: '1759370000000000000' }),
  },
  {
    name: 'a version read from a file without a read time is rejected',
    statement: insert('blob_refs', blobRef, { source: "'file_read'" }),
    error: /CHECK constraint failed: blob_refs_read_at/,
  },
  {
    name: 'a version taken from an action payload has no read time',
    statement: insert('blob_refs', blobRef, { read_at: '1759370000000000000' }),
    error: /CHECK constraint failed: blob_refs_read_at/,
  },
  {
    name: 'a blob reference of an unknown source is rejected',
    statement: insert('blob_refs', blobRef, { source: "'clipboard'" }),
    error: /CHECK constraint failed: source IN/,
  },
  {
    name: 'a blob reference needs stored content',
    statement: insert('blob_refs', blobRef, { hash: "'sha256:bb'" }),
    error: /FOREIGN KEY constraint failed/,
  },
  {
    name: 'blob content is stored as bytes',
    statement: "INSERT INTO blobs (hash, content) VALUES ('sha256:bb', 'hi')",
    error: /cannot store TEXT value in BLOB column blobs\.content/,
  },
]

test.for(cases)('$name', (schemaCase) => {
  checkSchemaCase(database, schemaCase)
})

test('blob content is deleted together with its last reference', () => {
  database.exec('SAVEPOINT release')
  database.exec(
    [insert('blob_refs', blobRef), insert('blob_refs', blobRef, { version_id: "'v2'" })].join('; '),
  )
  const count = database.prepare("SELECT count(*) AS blobs FROM blobs WHERE hash = 'sha256:aa'")
  database.exec("DELETE FROM blob_refs WHERE version_id = 'v1'")
  const afterFirst = count.get()
  database.exec("DELETE FROM blob_refs WHERE version_id = 'v2'")
  const afterLast = count.get()
  database.exec('ROLLBACK TO release; RELEASE release')

  expect(afterFirst).toEqual({ blobs: 1 })
  expect(afterLast).toEqual({ blobs: 0 })
})
