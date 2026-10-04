CREATE TABLE chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  stage_id TEXT,
  model_version INTEGER NOT NULL CHECK (model_version >= 0),
  question TEXT NOT NULL,
  answer TEXT,
  citations TEXT NOT NULL DEFAULT '[]' CHECK (json_type(citations) = 'array'),
  asked_at INTEGER NOT NULL,
  answered_at INTEGER CHECK (answered_at >= asked_at),
  change_seq INTEGER NOT NULL CHECK (change_seq > 0)
) STRICT;

CREATE INDEX chat_messages_run ON chat_messages (run_id, id);
CREATE INDEX chat_messages_change_seq ON chat_messages (change_seq);
