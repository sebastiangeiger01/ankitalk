-- 0017_mcp_oauth.sql
-- OAuth 2.1 (Authorization Code + PKCE) on top of the existing MCP bearer-token
-- infrastructure. This is what lets clients that ONLY support OAuth — notably Claude's
-- custom connectors — authenticate without the user pasting a static token.
--
-- Design: an OAuth access token is just another row in `mcp_tokens` (kind='oauth'), so the
-- existing `resolveTokenOwner` hash lookup and the `mcp_tool_audit` foreign key keep working
-- unchanged. The new columns track which client the grant belongs to and the rotating refresh
-- token. Dynamically-registered clients and short-lived authorization codes get their own
-- tables.

ALTER TABLE mcp_tokens ADD COLUMN kind TEXT NOT NULL DEFAULT 'static'; -- 'static' | 'oauth'
ALTER TABLE mcp_tokens ADD COLUMN client_id TEXT;                       -- set for kind='oauth'
ALTER TABLE mcp_tokens ADD COLUMN refresh_token_hash TEXT;             -- SHA-256 of the refresh token
ALTER TABLE mcp_tokens ADD COLUMN refresh_expires_at TEXT;

CREATE INDEX idx_mcp_tokens_refresh ON mcp_tokens(refresh_token_hash);

-- Dynamically registered OAuth clients (RFC 7591). Public clients (PKCE, no secret) only.
CREATE TABLE IF NOT EXISTS mcp_oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_name TEXT,
  redirect_uris TEXT NOT NULL,                                          -- JSON array of exact-match URIs
  grant_types TEXT NOT NULL DEFAULT 'authorization_code,refresh_token',
  token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none',
  scope TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Single-use authorization codes. Bound to the client, the approving user, the exact
-- redirect_uri, the PKCE challenge, and the approved scope. Consumed (deleted) on exchange.
CREATE TABLE IF NOT EXISTS mcp_oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL DEFAULT 'S256',
  scope TEXT NOT NULL,
  resource TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_mcp_oauth_codes_expiry ON mcp_oauth_codes(expires_at);
