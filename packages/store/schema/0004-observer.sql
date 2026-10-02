CREATE TABLE observer_calls (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  backend TEXT NOT NULL CHECK (backend IN ('claude', 'codex')),
  base_version INTEGER NOT NULL CHECK (base_version >= 0),
  input TEXT NOT NULL CHECK (json_valid(input)),
  output TEXT,
  verdict TEXT,
  reasons TEXT NOT NULL DEFAULT '[]' CHECK (json_type(reasons) = 'array'),
  usage TEXT CHECK (json_valid(usage)),
  started_at INTEGER NOT NULL,
  finished_at INTEGER CHECK (finished_at >= started_at),
  change_seq INTEGER NOT NULL CHECK (change_seq > 0)
) STRICT;

CREATE INDEX observer_calls_run ON observer_calls (run_id, started_at);
CREATE INDEX observer_calls_change_seq ON observer_calls (change_seq);
