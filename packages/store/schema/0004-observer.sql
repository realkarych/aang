CREATE TABLE observer_calls (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('batch', 'probe', 'auth_status')),
  run_id TEXT,
  backend TEXT NOT NULL CHECK (backend IN ('claude', 'codex')),
  base_version INTEGER CHECK (base_version >= 0),
  input TEXT CHECK (json_valid(input)),
  output TEXT,
  verdict TEXT,
  reasons TEXT NOT NULL DEFAULT '[]' CHECK (json_type(reasons) = 'array'),
  error_class TEXT CHECK (
    error_class IN (
      'auth',
      'limit',
      'timeout',
      'network',
      'invalid_output',
      'isolation',
      'cli_missing',
      'version_not_admitted',
      'process_stuck'
    )
  ),
  error_message TEXT,
  usage TEXT CHECK (json_valid(usage)),
  started_at INTEGER NOT NULL,
  finished_at INTEGER CHECK (finished_at >= started_at),
  delay_ms INTEGER CHECK (delay_ms >= 0),
  change_seq INTEGER NOT NULL CHECK (change_seq > 0),
  CONSTRAINT observer_calls_batch CHECK (
    kind <> 'batch' OR (run_id IS NOT NULL AND base_version IS NOT NULL AND input IS NOT NULL)
  ),
  CONSTRAINT observer_calls_check CHECK (
    kind = 'batch'
    OR (run_id IS NULL AND base_version IS NULL AND finished_at IS NOT NULL AND verdict IN ('accepted', 'failed'))
  ),
  CONSTRAINT observer_calls_auth_status CHECK (kind <> 'auth_status' OR (input IS NULL AND usage IS NULL)),
  CONSTRAINT observer_calls_error CHECK ((error_class IS NULL) = (error_message IS NULL)),
  CONSTRAINT observer_calls_delay CHECK (delay_ms IS NULL OR (kind = 'batch' AND verdict = 'accepted'))
) STRICT;

CREATE INDEX observer_calls_run ON observer_calls (run_id, started_at);
CREATE INDEX observer_calls_finished ON observer_calls (finished_at);
CREATE INDEX observer_calls_change_seq ON observer_calls (change_seq);
