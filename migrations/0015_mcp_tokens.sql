-- 0015_mcp_tokens.sql
-- API tokens that authenticate MCP (Model Context Protocol) clients into AnkiTalk's
-- /api/mcp endpoint. The user generates a token in Settings → MCP, pastes it into
-- their ElevenLabs agent's MCP server configuration (or any other MCP client), and we
-- authenticate every JSON-RPC request against the hashed value.
--
-- We store only the SHA-256 hash so a DB leak can't expose live tokens. The plaintext
-- is shown to the user exactly once at creation time. `label` lets a user run multiple
-- tokens (e.g. one per client / device) without having to remember which is which.

CREATE TABLE IF NOT EXISTS mcp_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,        -- first 8 chars of the plaintext, shown in the UI for identification
  label TEXT,
  last_used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_mcp_tokens_user ON mcp_tokens(user_id, created_at);
