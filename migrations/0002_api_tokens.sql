-- Personal access tokens for outside agents (Glean, Claude Code, Cursor, …) that
-- reach the board over MCP. Like sessions, only a hash of each token is stored.
CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX api_tokens_email ON api_tokens (email);
