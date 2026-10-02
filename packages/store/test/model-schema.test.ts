import type { DatabaseSync } from 'node:sqlite'
import { beforeAll, test } from 'vitest'
import { checkSchemaCase, createSchemaDatabase, insert, type Row, type SchemaCase } from './home.js'

const observerCall: Row = {
  id: "'c1'",
  run_id: "'r1'",
  backend: "'claude'",
  base_version: '0',
  input: "'{}'",
  output: 'NULL',
  verdict: 'NULL',
  reasons: "'[]'",
  usage: 'NULL',
  started_at: '1759370000000000000',
  finished_at: 'NULL',
  change_seq: '1',
}

const modelVersion: Row = {
  run_id: "'r1'",
  version: '1',
  base_version: '0',
  author: "'observer'",
  observer_call_id: "'c1'",
  created_at: '1759370000000000000',
  change_seq: '2',
}

const modelChange: Row = {
  run_id: "'r1'",
  version: '1',
  change_index: '1',
  operation: "'stage.create'",
  entity_kind: "'stage'",
  entity_id: "'st1'",
  before_state: 'NULL',
  after_state: '\'{"title":"Build"}\'',
  author: "'observer'",
  basis: "'interpreted'",
  interpreter: "'llm:c1'",
  evidence: '\'["f1"]\'',
  rationale: "'plan item'",
  observer_call_id: "'c1'",
}

const modelEntity: Row = {
  run_id: "'r1'",
  id: "'st1'",
  kind: "'stage'",
  data: "'{}'",
  version: '1',
  change_seq: '2',
}

const interpretation: Row = {
  run_id: "'r1'",
  fact_id: "'f1'",
  status: "'pending'",
  attempts: '0',
  observer_call_id: 'NULL',
}

const viewMark: Row = {
  run_id: "'r1'",
  model_version: '1',
  change_seq: '2',
  viewed_at: '1759370000000000000',
}

const attentionView: Row = {
  run_id: "'r1'",
  item_id: "'a1'",
  viewed_at: '1759370000000000000',
  change_seq: '3',
}

const viewRule: Row = {
  run_id: "'r1'",
  action: "'group'",
  selector: '\'{"agent":{"type":"reviewer"}}\'',
  params: '\'{"name":"Reviewers"}\'',
  source: "'chat'",
  created_at: '1759370000000000000',
  revoked_at: 'NULL',
  change_seq: '3',
}

const chatMessage: Row = {
  run_id: "'r1'",
  stage_id: 'NULL',
  model_version: '1',
  question: "'What is left?'",
  answer: 'NULL',
  citations: "'[]'",
  usage: 'NULL',
  asked_at: '1759370000000000000',
  answered_at: 'NULL',
  change_seq: '3',
}

const setting: Row = {
  key: "'observer.backend'",
  value: '\'"claude"\'',
  updated_at: '1759370000000000000',
}

let database: DatabaseSync

beforeAll(async () => {
  const schema = await createSchemaDatabase()
  database = schema.database
  database.exec(
    [
      insert('observer_calls', observerCall),
      insert('model_versions', modelVersion),
      insert('model_changes', modelChange, { change_index: '0' }),
      insert('model_entities', modelEntity),
    ].join('; '),
  )
  return schema.dispose
})

const cases: readonly SchemaCase[] = [
  {
    name: 'a finished observer call keeps its raw output, verdict, reasons and usage',
    statement: insert('observer_calls', observerCall, {
      id: "'c2'",
      output: "'not json'",
      verdict: "'rejected'",
      reasons: '\'["conflict"]\'',
      usage: '\'{"input_tokens":10}\'',
      finished_at: '1759370009000000000',
    }),
  },
  {
    name: 'an observer call from an unknown backend is rejected',
    statement: insert('observer_calls', observerCall, { id: "'c2'", backend: "'gemini'" }),
    error: /CHECK constraint failed: backend IN/,
  },
  {
    name: 'an observer call needs its base model version',
    statement: insert('observer_calls', observerCall, { id: "'c2'", base_version: 'NULL' }),
    error: /NOT NULL constraint failed: observer_calls\.base_version/,
  },
  {
    name: 'an observer call input must be JSON',
    statement: insert('observer_calls', observerCall, { id: "'c2'", input: "'batch'" }),
    error: /CHECK constraint failed: json_valid\(input\)/,
  },
  {
    name: 'observer call rejection reasons are a JSON array',
    statement: insert('observer_calls', observerCall, { id: "'c2'", reasons: '\'{"reason":"conflict"}\'' }),
    error: /CHECK constraint failed: json_type\(reasons\)/,
  },
  {
    name: 'an observer call cannot finish before it started',
    statement: insert('observer_calls', observerCall, { id: "'c2'", finished_at: '1759369999999999999' }),
    error: /CHECK constraint failed: finished_at >= started_at/,
  },
  {
    name: 'model versions start at one',
    statement: insert('model_versions', modelVersion, { version: '0' }),
    error: /CHECK constraint failed: version > 0/,
  },
  {
    name: 'a model version is numbered once per run',
    statement: insert('model_versions', modelVersion),
    error: /UNIQUE constraint failed: model_versions\.run_id, model_versions\.version/,
  },
  {
    name: 'the same version number may exist in another run',
    statement: insert('model_versions', modelVersion, { run_id: "'r2'" }),
  },
  {
    name: 'a model version is based on an earlier version',
    statement: insert('model_versions', modelVersion, { version: '2', base_version: '2' }),
    error: /CHECK constraint failed: base_version >= 0 AND base_version < version/,
  },
  {
    name: 'a version of rule changes needs no observer call',
    statement: insert('model_versions', modelVersion, { version: '2', author: "'rule'", observer_call_id: 'NULL' }),
  },
  {
    name: 'a version of observer changes names its observer call',
    statement: insert('model_versions', modelVersion, { version: '2', observer_call_id: 'NULL' }),
    error: /CHECK constraint failed: model_versions_observer_call/,
  },
  {
    name: 'a version of user changes has no observer call',
    statement: insert('model_versions', modelVersion, { version: '2', author: "'user'" }),
    error: /CHECK constraint failed: model_versions_observer_call/,
  },
  {
    name: 'a version refers to a recorded observer call',
    statement: insert('model_versions', modelVersion, { version: '2', observer_call_id: "'c9'" }),
    error: /FOREIGN KEY constraint failed/,
  },
  {
    name: 'a rule change interpreted by a named rule needs no observer call',
    statement: insert('model_changes', modelChange, {
      operation: "'attention.add'",
      entity_kind: "'attention'",
      entity_id: "'a1'",
      author: "'rule'",
      interpreter: "'rule:permission-request'",
      observer_call_id: 'NULL',
    }),
  },
  {
    name: 'a user change records what was observed',
    statement: insert('model_changes', modelChange, {
      operation: "'attention.dismiss'",
      before_state: "'{}'",
      after_state: 'NULL',
      author: "'user'",
      basis: "'observed'",
      interpreter: 'NULL',
      evidence: "'[]'",
      observer_call_id: 'NULL',
    }),
  },
  {
    name: 'an observer change may be claimed by the solver',
    statement: insert('model_changes', modelChange, { basis: "'claimed'", interpreter: 'NULL' }),
  },
  {
    name: 'a model change takes one position within its version',
    statement: insert('model_changes', modelChange, { change_index: '0' }),
    error: /UNIQUE constraint failed: model_changes\.run_id, model_changes\.version, model_changes\.change_index/,
  },
  {
    name: 'a model change position cannot be negative',
    statement: insert('model_changes', modelChange, { change_index: '-1' }),
    error: /CHECK constraint failed: change_index >= 0/,
  },
  {
    name: 'a model change belongs to a recorded model version',
    statement: insert('model_changes', modelChange, { version: '2' }),
    error: /FOREIGN KEY constraint failed/,
  },
  {
    name: 'a model change from an unknown author is rejected',
    statement: insert('model_changes', modelChange, { author: "'llm'" }),
    error: /CHECK constraint failed: author IN/,
  },
  {
    name: 'an observer change names its observer call',
    statement: insert('model_changes', modelChange, { observer_call_id: 'NULL' }),
    error: /CHECK constraint failed: model_changes_observer_call/,
  },
  {
    name: 'a rule change has no observer call',
    statement: insert('model_changes', modelChange, { author: "'rule'", interpreter: "'rule:plan'" }),
    error: /CHECK constraint failed: model_changes_observer_call/,
  },
  {
    name: 'an observer change refers to a recorded observer call',
    statement: insert('model_changes', modelChange, { interpreter: "'llm:c9'", observer_call_id: "'c9'" }),
    error: /FOREIGN KEY constraint failed/,
  },
  {
    name: 'the observer never produces an observed basis',
    statement: insert('model_changes', modelChange, { basis: "'observed'", interpreter: 'NULL' }),
    error: /CHECK constraint failed: model_changes_observer_basis/,
  },
  {
    name: 'an interpreted change names its interpreter',
    statement: insert('model_changes', modelChange, { interpreter: 'NULL' }),
    error: /CHECK constraint failed: model_changes_interpreter/,
  },
  {
    name: 'model change evidence is a JSON array of fact ids',
    statement: insert('model_changes', modelChange, { evidence: "'\"f1\"'" }),
    error: /CHECK constraint failed: json_type\(evidence\)/,
  },
  {
    name: 'a model change records a state before or after',
    statement: insert('model_changes', modelChange, { after_state: 'NULL' }),
    error: /CHECK constraint failed: model_changes_state/,
  },
  {
    name: 'a model entity is projected from a recorded model version',
    statement: insert('model_entities', modelEntity, { id: "'st2'", version: '2' }),
    error: /FOREIGN KEY constraint failed/,
  },
  {
    name: 'a model entity is projected once per kind and id within its run',
    statement: insert('model_entities', modelEntity, { data: '\'{"title":"Build"}\'' }),
    error: /UNIQUE constraint failed: model_entities\.run_id, model_entities\.kind, model_entities\.id/,
  },
  {
    name: 'entities of different kinds may share an id',
    statement: insert('model_entities', modelEntity, { kind: "'criterion'" }),
  },
  {
    name: 'model entity data must be JSON',
    statement: insert('model_entities', modelEntity, { id: "'st2'", data: "'stage'" }),
    error: /CHECK constraint failed: json_valid\(data\)/,
  },
  {
    name: 'a pending fact needs no observer call',
    statement: insert('fact_interpretation', interpretation),
  },
  {
    name: 'a fact beyond the queue limit is deferred',
    statement: insert('fact_interpretation', interpretation, { status: "'deferred'" }),
  },
  {
    name: 'a fact sent to the observer names the call',
    statement: insert('fact_interpretation', interpretation, { status: "'in_call'", observer_call_id: "'c1'" }),
  },
  {
    name: 'a fact moved to another run has its own status there',
    setup: [insert('fact_interpretation', interpretation, { status: "'interpreted'", observer_call_id: "'c1'" })],
    statement: insert('fact_interpretation', interpretation, { run_id: "'r2'" }),
  },
  {
    name: 'a fact has one interpretation status per run',
    setup: [insert('fact_interpretation', interpretation)],
    statement: insert('fact_interpretation', interpretation, { status: "'not_interpreted'", attempts: '3' }),
    error: /UNIQUE constraint failed: fact_interpretation\.run_id, fact_interpretation\.fact_id/,
  },
  {
    name: 'an unknown interpretation status is rejected',
    statement: insert('fact_interpretation', interpretation, { status: "'queued'" }),
    error: /CHECK constraint failed: status IN/,
  },
  {
    name: 'a fact in a call without the call is rejected',
    statement: insert('fact_interpretation', interpretation, { status: "'in_call'" }),
    error: /CHECK constraint failed: fact_interpretation_call/,
  },
  {
    name: 'an interpreted fact without the call is rejected',
    statement: insert('fact_interpretation', interpretation, { status: "'interpreted'" }),
    error: /CHECK constraint failed: fact_interpretation_call/,
  },
  {
    name: 'interpretation attempts cannot be negative',
    statement: insert('fact_interpretation', interpretation, { attempts: '-1' }),
    error: /CHECK constraint failed: attempts >= 0/,
  },
  {
    name: 'a view mark taken before the first model version is accepted',
    statement: insert('view_marks', viewMark, { model_version: '0', change_seq: '0' }),
  },
  {
    name: 'a run has a single view mark',
    setup: [insert('view_marks', viewMark)],
    statement: insert('view_marks', viewMark, { model_version: '2', change_seq: '5' }),
    error: /UNIQUE constraint failed: view_marks\.run_id/,
  },
  {
    name: 'a view mark keeps the model version together with the change sequence number',
    statement: insert('view_marks', viewMark, { change_seq: 'NULL' }),
    error: /NOT NULL constraint failed: view_marks\.change_seq/,
  },
  {
    name: 'an attention item is marked viewed once per run',
    setup: [insert('attention_views', attentionView)],
    statement: insert('attention_views', attentionView, { change_seq: '4' }),
    error: /UNIQUE constraint failed: attention_views\.run_id, attention_views\.item_id/,
  },
  {
    name: 'a collapse rule from the interface has no parameters',
    statement: insert('view_rules', viewRule, { action: "'collapse'", params: 'NULL', source: "'ui'" }),
  },
  {
    name: 'a view rule with an unknown action is rejected',
    statement: insert('view_rules', viewRule, { action: "'delete'" }),
    error: /CHECK constraint failed: action IN/,
  },
  {
    name: 'a view rule from an unknown source is rejected',
    statement: insert('view_rules', viewRule, { source: "'observer'" }),
    error: /CHECK constraint failed: source IN/,
  },
  {
    name: 'a view rule selector is a JSON object',
    statement: insert('view_rules', viewRule, { selector: '\'["reviewer"]\'' }),
    error: /CHECK constraint failed: json_type\(selector\)/,
  },
  {
    name: 'a view rule cannot be revoked before it was created',
    statement: insert('view_rules', viewRule, { revoked_at: '1759369999999999999' }),
    error: /CHECK constraint failed: revoked_at >= created_at/,
  },
  {
    name: 'an answered chat message keeps its citations and usage',
    statement: insert('chat_messages', chatMessage, {
      stage_id: "'st1'",
      answer: "'Two stages remain.'",
      citations: '\'[{"kind":"stage","id":"st1"}]\'',
      usage: '\'{"input_tokens":10}\'',
      answered_at: '1759370005000000000',
    }),
  },
  {
    name: 'chat citations are a JSON array',
    statement: insert('chat_messages', chatMessage, { citations: '\'{"kind":"stage"}\'' }),
    error: /CHECK constraint failed: json_type\(citations\)/,
  },
  {
    name: 'a chat answer cannot precede its question',
    statement: insert('chat_messages', chatMessage, { answered_at: '1759369999999999999' }),
    error: /CHECK constraint failed: answered_at >= asked_at/,
  },
  {
    name: 'a chat message refers to a model version',
    statement: insert('chat_messages', chatMessage, { model_version: 'NULL' }),
    error: /NOT NULL constraint failed: chat_messages\.model_version/,
  },
  {
    name: 'a setting value is JSON',
    statement: insert('settings', setting, { value: "'claude'" }),
    error: /CHECK constraint failed: json_valid\(value\)/,
  },
  {
    name: 'a setting is stored once per key',
    setup: [insert('settings', setting)],
    statement: insert('settings', setting, { value: '\'"codex"\'' }),
    error: /UNIQUE constraint failed: settings\.key/,
  },
]

test.for(cases)('$name', (schemaCase) => {
  checkSchemaCase(database, schemaCase)
})
