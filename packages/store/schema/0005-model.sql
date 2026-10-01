CREATE TABLE model_versions (
  run_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  base_version INTEGER NOT NULL CHECK (base_version >= 0 AND base_version < version),
  created_at INTEGER NOT NULL,
  change_seq INTEGER NOT NULL CHECK (change_seq > 0),
  PRIMARY KEY (run_id, version)
) STRICT;

CREATE INDEX model_versions_change_seq ON model_versions (change_seq);

CREATE TABLE model_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  operation TEXT NOT NULL,
  entity_kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  before_state TEXT CHECK (json_valid(before_state)),
  after_state TEXT CHECK (json_valid(after_state)),
  author TEXT NOT NULL CHECK (author IN ('rule', 'observer', 'user')),
  basis TEXT NOT NULL CHECK (basis IN ('observed', 'claimed', 'interpreted')),
  interpreter TEXT,
  evidence TEXT NOT NULL CHECK (json_type(evidence) = 'array'),
  rationale TEXT,
  observer_call_id TEXT REFERENCES observer_calls (id),
  FOREIGN KEY (run_id, version) REFERENCES model_versions (run_id, version),
  CONSTRAINT model_changes_state CHECK (before_state IS NOT NULL OR after_state IS NOT NULL),
  CONSTRAINT model_changes_observer_call CHECK ((author = 'observer') = (observer_call_id IS NOT NULL)),
  CONSTRAINT model_changes_observer_basis CHECK (author <> 'observer' OR basis <> 'observed'),
  CONSTRAINT model_changes_interpreter CHECK (
    CASE basis
      WHEN 'interpreted' THEN interpreter IS NOT NULL AND (interpreter GLOB 'rule:?*' OR interpreter GLOB 'llm:?*')
      ELSE interpreter IS NULL
    END
  )
) STRICT;

CREATE INDEX model_changes_version ON model_changes (run_id, version);
CREATE INDEX model_changes_entity ON model_changes (run_id, entity_id);
CREATE INDEX model_changes_observer_call ON model_changes (observer_call_id);

CREATE TABLE model_entities (
  run_id TEXT NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL,
  data TEXT NOT NULL CHECK (json_valid(data)),
  version INTEGER NOT NULL,
  change_seq INTEGER NOT NULL CHECK (change_seq > 0),
  PRIMARY KEY (run_id, id),
  FOREIGN KEY (run_id, version) REFERENCES model_versions (run_id, version)
) STRICT;

CREATE INDEX model_entities_kind ON model_entities (run_id, kind);
CREATE INDEX model_entities_version ON model_entities (run_id, version);
CREATE INDEX model_entities_change_seq ON model_entities (change_seq);

CREATE TABLE fact_interpretation (
  run_id TEXT NOT NULL,
  fact_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'in_call', 'interpreted', 'deferred', 'not_interpreted')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  observer_call_id TEXT REFERENCES observer_calls (id),
  PRIMARY KEY (run_id, fact_id),
  CONSTRAINT fact_interpretation_call CHECK (status NOT IN ('in_call', 'interpreted') OR observer_call_id IS NOT NULL)
) STRICT;

CREATE INDEX fact_interpretation_status ON fact_interpretation (run_id, status);
CREATE INDEX fact_interpretation_observer_call ON fact_interpretation (observer_call_id);

CREATE TABLE view_marks (
  run_id TEXT PRIMARY KEY,
  model_version INTEGER NOT NULL CHECK (model_version >= 0),
  change_seq INTEGER NOT NULL CHECK (change_seq >= 0),
  viewed_at INTEGER NOT NULL
) STRICT;

CREATE TABLE attention_views (
  run_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  viewed_at INTEGER NOT NULL,
  change_seq INTEGER NOT NULL CHECK (change_seq > 0),
  PRIMARY KEY (run_id, item_id)
) STRICT;

CREATE INDEX attention_views_change_seq ON attention_views (change_seq);

CREATE TABLE view_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('collapse', 'hide', 'group', 'detail')),
  selector TEXT NOT NULL CHECK (json_type(selector) = 'object'),
  params TEXT CHECK (json_type(params) = 'object'),
  source TEXT NOT NULL CHECK (source IN ('chat', 'ui')),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER CHECK (revoked_at >= created_at),
  change_seq INTEGER NOT NULL CHECK (change_seq > 0)
) STRICT;

CREATE INDEX view_rules_run ON view_rules (run_id);
CREATE INDEX view_rules_change_seq ON view_rules (change_seq);
