-- One row per person who has signed in, or whom an admin added by email ahead of time
-- (src/users.ts). It holds what Stripe doesn't: who is an admin, and who was given Pro by an
-- admin instead of paying for it. Stripe's own state stays in `subscriptions`.
--
-- user_id is the hash the rest of the app knows a user by (userIdFor in src/auth.ts). SQLite
-- can't compute it, so rows backfilled below get theirs the next time that person signs in.
CREATE TABLE users (
  email TEXT PRIMARY KEY,
  user_id TEXT,
  role TEXT NOT NULL DEFAULT 'user',        -- 'user' or 'admin'
  pro_grant INTEGER NOT NULL DEFAULT 0,     -- 1: an admin gave this account Pro
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,                     -- last sign-in; NULL until they've signed in
  changed_by TEXT,                          -- the admin who last changed role or pro_grant
  changed_at INTEGER
);
CREATE UNIQUE INDEX users_user_id ON users (user_id);

-- Everyone the database already knows about: subscribers, live sessions, and token holders.
INSERT OR IGNORE INTO users (email, user_id, created_at)
  SELECT email, user_id, MIN(updated_at) FROM subscriptions WHERE email != '' GROUP BY email;
INSERT OR IGNORE INTO users (email, created_at, last_seen_at)
  SELECT email, MIN(created_at), MAX(created_at) FROM sessions GROUP BY email;
INSERT OR IGNORE INTO users (email, created_at)
  SELECT email, MIN(created_at) FROM api_tokens GROUP BY email;
