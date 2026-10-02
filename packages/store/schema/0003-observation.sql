CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  root_session_key TEXT NOT NULL UNIQUE,
  runtime TEXT NOT NULL CHECK (runtime IN ('claude', 'codex')),
  data TEXT NOT NULL CHECK (json_valid(data)),
  change_seq INTEGER NOT NULL CHECK (change_seq > 0)
) STRICT;

CREATE INDEX runs_change_seq ON runs (change_seq);

CREATE TABLE objects (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  entity_key TEXT NOT NULL,
  run_id TEXT,
  data TEXT NOT NULL CHECK (json_valid(data)),
  change_seq INTEGER NOT NULL CHECK (change_seq > 0),
  UNIQUE (kind, entity_key)
) STRICT;

CREATE INDEX objects_run ON objects (run_id, kind);
CREATE INDEX objects_change_seq ON objects (change_seq);

CREATE TABLE links (
  kind TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  basis TEXT NOT NULL CHECK (basis IN ('observed', 'claimed', 'interpreted')),
  interpreter TEXT,
  evidence TEXT NOT NULL CHECK (json_type(evidence) = 'array'),
  change_seq INTEGER NOT NULL CHECK (change_seq > 0),
  PRIMARY KEY (kind, from_id, to_id),
  CONSTRAINT links_interpreter CHECK (
    CASE basis
      WHEN 'interpreted' THEN interpreter IS NOT NULL AND (interpreter GLOB 'rule:?*' OR interpreter GLOB 'llm:?*')
      ELSE interpreter IS NULL
    END
  )
) STRICT;

CREATE INDEX links_from ON links (from_id);
CREATE INDEX links_to ON links (to_id);
CREATE INDEX links_change_seq ON links (change_seq);

CREATE TABLE bindings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('attach', 'fork_parent', 'detach')),
  session_id TEXT NOT NULL,
  target_run_id TEXT,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER CHECK (revoked_at >= created_at),
  change_seq INTEGER NOT NULL CHECK (change_seq > 0),
  CONSTRAINT bindings_target CHECK ((kind = 'detach') = (target_run_id IS NULL))
) STRICT;

CREATE INDEX bindings_session ON bindings (session_id);
CREATE INDEX bindings_change_seq ON bindings (change_seq);

CREATE TABLE blobs (
  hash TEXT PRIMARY KEY,
  content BLOB NOT NULL
) STRICT;

CREATE TABLE blob_refs (
  hash TEXT NOT NULL REFERENCES blobs (hash),
  version_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('action_payload', 'file_read')),
  read_at INTEGER,
  PRIMARY KEY (hash, version_id),
  CONSTRAINT blob_refs_read_at CHECK ((source = 'file_read') = (read_at IS NOT NULL))
) STRICT;

CREATE INDEX blob_refs_version ON blob_refs (version_id);

CREATE TRIGGER blob_refs_release_blob AFTER DELETE ON blob_refs
WHEN NOT EXISTS (SELECT 1 FROM blob_refs WHERE hash = OLD.hash)
BEGIN
  DELETE FROM blobs WHERE hash = OLD.hash;
END;
