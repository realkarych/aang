CREATE TABLE streams (
  stream TEXT PRIMARY KEY,
  runtime TEXT NOT NULL CHECK (runtime IN ('claude', 'codex')),
  scope TEXT NOT NULL CHECK (scope IN ('watched', 'external', 'observer'))
) STRICT;

CREATE TABLE session_scopes (
  runtime TEXT NOT NULL CHECK (runtime IN ('claude', 'codex')),
  session TEXT NOT NULL CHECK (session <> ''),
  scope TEXT NOT NULL CHECK (scope IN ('watched', 'external', 'observer')),
  PRIMARY KEY (runtime, session)
) STRICT;

CREATE TABLE cursors (
  path TEXT PRIMARY KEY,
  stream TEXT REFERENCES streams (stream),
  dev TEXT NOT NULL CHECK (dev <> '' AND dev NOT GLOB '*[^0-9]*'),
  inode TEXT NOT NULL CHECK (inode <> '' AND inode NOT GLOB '*[^0-9]*'),
  byte_offset INTEGER NOT NULL CHECK (byte_offset >= 0),
  line_number INTEGER NOT NULL CHECK (line_number >= 0),
  size INTEGER NOT NULL CHECK (size >= byte_offset),
  last_ordinal INTEGER CHECK (last_ordinal >= 0)
) STRICT;

CREATE INDEX cursors_stream ON cursors (stream);

CREATE TABLE raw_records (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key TEXT NOT NULL UNIQUE,
  channel TEXT NOT NULL CHECK (channel IN ('hook', 'transcript', 'rollout', 'otel', 'registry', 'snapshot', 'context')),
  runtime TEXT CHECK (runtime IN ('claude', 'codex')),
  stream TEXT,
  position TEXT NOT NULL CHECK (json_valid(position)),
  hook TEXT CHECK (json_valid(hook)),
  observed_at INTEGER NOT NULL,
  source_ts INTEGER,
  payload BLOB NOT NULL,
  parse_state TEXT NOT NULL CHECK (parse_state IN ('parsed', 'unknown', 'invalid')),
  change_seq INTEGER NOT NULL CHECK (change_seq > 0),
  CONSTRAINT raw_records_runtime_channel CHECK (runtime IS NOT NULL OR channel IN ('snapshot', 'context')),
  CONSTRAINT raw_records_hook_channel CHECK (hook IS NULL OR channel = 'hook')
) STRICT;

CREATE INDEX raw_records_stream ON raw_records (stream, seq);
CREATE INDEX raw_records_change_seq ON raw_records (change_seq);

CREATE TABLE facts (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL REFERENCES raw_records (seq) ON DELETE CASCADE,
  record_index INTEGER NOT NULL CHECK (record_index >= 0),
  kind TEXT NOT NULL,
  entity_key TEXT NOT NULL CHECK (json_valid(entity_key)),
  speaker TEXT NOT NULL CHECK (speaker IN ('human', 'solver', 'tool', 'runtime')),
  urgent INTEGER NOT NULL CHECK (urgent IN (0, 1)),
  occurred_at INTEGER NOT NULL,
  runtime_ids TEXT NOT NULL CHECK (json_valid(runtime_ids)),
  runtime_env TEXT NOT NULL CHECK (json_valid(runtime_env)),
  format_verified INTEGER NOT NULL CHECK (format_verified IN (0, 1)),
  redelivery_key TEXT,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  normalizer_version INTEGER NOT NULL CHECK (normalizer_version > 0),
  change_seq INTEGER NOT NULL CHECK (change_seq > 0),
  UNIQUE (seq, record_index)
) STRICT;

CREATE INDEX facts_entity_key ON facts (entity_key);
CREATE INDEX facts_change_seq ON facts (change_seq);

CREATE TABLE gaps (
  id TEXT PRIMARY KEY,
  entity_key TEXT NOT NULL CHECK (json_valid(entity_key)),
  kind TEXT NOT NULL,
  run_id TEXT,
  session_id TEXT,
  stream TEXT,
  details TEXT,
  detected_at INTEGER NOT NULL,
  closed_at INTEGER CHECK (closed_at >= detected_at),
  change_seq INTEGER NOT NULL CHECK (change_seq > 0)
) STRICT;

CREATE INDEX gaps_stream ON gaps (stream);
CREATE INDEX gaps_run ON gaps (run_id);
CREATE INDEX gaps_change_seq ON gaps (change_seq);

CREATE TABLE pruned_streams (
  stream TEXT PRIMARY KEY,
  runtime TEXT NOT NULL CHECK (runtime IN ('claude', 'codex')),
  last_ordinal INTEGER CHECK (last_ordinal >= 0),
  byte_offset INTEGER CHECK (byte_offset >= 0),
  prefix_hash TEXT,
  pruned_at INTEGER NOT NULL,
  CONSTRAINT pruned_streams_boundary CHECK (
    (runtime = 'claude' AND byte_offset IS NOT NULL AND prefix_hash IS NOT NULL AND last_ordinal IS NULL)
    OR (runtime = 'codex' AND last_ordinal IS NOT NULL AND byte_offset IS NULL AND prefix_hash IS NULL)
  )
) STRICT;
