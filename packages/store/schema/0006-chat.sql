CREATE TABLE chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  stage_id TEXT,
  model_version INTEGER NOT NULL CHECK (model_version >= 0),
  question TEXT NOT NULL CHECK (question <> ''),
  status TEXT NOT NULL CHECK (status IN ('pending', 'answered', 'failed')),
  answer TEXT,
  citations TEXT NOT NULL DEFAULT '[]' CHECK (json_type(citations) = 'array'),
  unconfirmed_citations INTEGER NOT NULL DEFAULT 0 CHECK (unconfirmed_citations IN (0, 1)),
  insufficient_data INTEGER NOT NULL DEFAULT 0 CHECK (insufficient_data IN (0, 1)),
  view_rule_id INTEGER CHECK (view_rule_id > 0),
  error TEXT,
  asked_at INTEGER NOT NULL,
  answered_at INTEGER CHECK (answered_at >= asked_at),
  change_seq INTEGER NOT NULL CHECK (change_seq > 0),
  CONSTRAINT chat_messages_finished CHECK ((status = 'pending') = (answered_at IS NULL)),
  CONSTRAINT chat_messages_error CHECK ((status = 'failed') = (error IS NOT NULL)),
  CONSTRAINT chat_messages_unanswered CHECK (
    status = 'answered'
    OR (
      answer IS NULL
      AND citations = '[]'
      AND unconfirmed_citations = 0
      AND insufficient_data = 0
      AND view_rule_id IS NULL
    )
  )
) STRICT;

CREATE INDEX chat_messages_run ON chat_messages (run_id, id);
CREATE INDEX chat_messages_change_seq ON chat_messages (change_seq);
CREATE INDEX chat_messages_pending ON chat_messages (id) WHERE status = 'pending';
