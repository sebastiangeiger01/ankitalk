CREATE TABLE user_api_keys (
  user_id TEXT NOT NULL,
  service TEXT NOT NULL,
  encrypted_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, service),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE api_usage (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  service TEXT NOT NULL,
  operation TEXT NOT NULL,
  units INTEGER NOT NULL,
  estimated_cost_usd REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX idx_api_usage_user_date ON api_usage(user_id, created_at);
