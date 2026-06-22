-- Production MCP architecture: scoped credentials, tool audit trail, idempotent
-- writes, and a D1 FTS5 index over normalized note values.

ALTER TABLE mcp_tokens ADD COLUMN scopes TEXT NOT NULL DEFAULT 'cards:read,study:read';
ALTER TABLE mcp_tokens ADD COLUMN expires_at TEXT;

CREATE TABLE IF NOT EXISTS mcp_tool_audit (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_id TEXT NOT NULL REFERENCES mcp_tokens(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  status TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  result_bytes INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_mcp_tool_audit_user_date
  ON mcp_tool_audit(user_id, created_at);
CREATE INDEX idx_mcp_tool_audit_token_date
  ON mcp_tool_audit(token_id, created_at);

CREATE TABLE IF NOT EXISTS mcp_idempotency_keys (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, tool_name, idempotency_key)
);

-- Store only searchable note text in FTS. Cards are rendered with their actual
-- templates and cloze ordinal after retrieval, so the index never becomes the
-- source of truth for what the learner sees.
CREATE VIRTUAL TABLE note_search_fts USING fts5(
  note_id UNINDEXED,
  user_id UNINDEXED,
  deck_id UNINDEXED,
  content,
  tags,
  model_name,
  tokenize = 'unicode61 remove_diacritics 2',
  prefix = '2 3 4'
);

INSERT INTO note_search_fts(rowid, note_id, user_id, deck_id, content, tags, model_name)
SELECT
  n.rowid,
  n.id,
  n.user_id,
  n.deck_id,
  COALESCE((
    SELECT group_concat(COALESCE(json_extract(field.value, '$.value'), ''), ' ')
    FROM json_each(n.fields) AS field
  ), ''),
  n.tags,
  n.model_name
FROM notes n;

CREATE TRIGGER notes_search_after_insert
AFTER INSERT ON notes
BEGIN
  INSERT INTO note_search_fts(rowid, note_id, user_id, deck_id, content, tags, model_name)
  VALUES (
    NEW.rowid,
    NEW.id,
    NEW.user_id,
    NEW.deck_id,
    COALESCE((
      SELECT group_concat(COALESCE(json_extract(field.value, '$.value'), ''), ' ')
      FROM json_each(NEW.fields) AS field
    ), ''),
    NEW.tags,
    NEW.model_name
  );
END;

CREATE TRIGGER notes_search_after_update
AFTER UPDATE OF fields, tags, model_name, deck_id, user_id ON notes
BEGIN
  DELETE FROM note_search_fts WHERE rowid = OLD.rowid;
  INSERT INTO note_search_fts(rowid, note_id, user_id, deck_id, content, tags, model_name)
  VALUES (
    NEW.rowid,
    NEW.id,
    NEW.user_id,
    NEW.deck_id,
    COALESCE((
      SELECT group_concat(COALESCE(json_extract(field.value, '$.value'), ''), ' ')
      FROM json_each(NEW.fields) AS field
    ), ''),
    NEW.tags,
    NEW.model_name
  );
END;

CREATE TRIGGER notes_search_after_delete
AFTER DELETE ON notes
BEGIN
  DELETE FROM note_search_fts WHERE rowid = OLD.rowid;
END;
