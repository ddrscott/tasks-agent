-- Team boards (src/members.ts). A Pro owner invites people into their board by email, as a
-- viewer or a writer. The board itself stays in the owner's Durable Object; these tables only
-- say who may reach it.

-- One row per person on a board, pending or accepted. Declining, revoking, removing, and
-- leaving delete the row; board_audit keeps what happened. The owner has no row.
-- member_email is lower-cased and trimmed exactly as sign-in does it, and member_id is the
-- account id that address signs in as (userIdFor in src/auth.ts), so an invite can exist
-- before the person has ever signed in.
CREATE TABLE board_members (
  owner_id TEXT NOT NULL,
  owner_email TEXT NOT NULL,
  member_email TEXT NOT NULL,
  member_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('viewer', 'writer')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted')),
  -- SHA-256 of the invite link's token. The token itself is only ever in the email. NULL once
  -- the invite is accepted, so a used link matches nothing.
  token_hash TEXT,
  expires_at INTEGER,
  invited_at INTEGER NOT NULL,
  accepted_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, member_email)
);
-- Boards shared with me.
CREATE INDEX board_members_member ON board_members (member_id, status);
-- Invite lookup by token hash; also makes a hash collision between two invites impossible.
CREATE UNIQUE INDEX board_members_token ON board_members (token_hash) WHERE token_hash IS NOT NULL;

-- Who did what to a board's membership, and when. Append-only: the triggers below refuse
-- every UPDATE and DELETE, so the app can't rewrite it even by mistake.
CREATE TABLE board_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  -- The signed-in email that did it, or 'system' for a plan change.
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  from_role TEXT,
  to_role TEXT
);
CREATE INDEX board_audit_owner ON board_audit (owner_id, id);
CREATE TRIGGER board_audit_no_update BEFORE UPDATE ON board_audit
BEGIN SELECT RAISE(ABORT, 'board_audit is append-only'); END;
CREATE TRIGGER board_audit_no_delete BEFORE DELETE ON board_audit
BEGIN SELECT RAISE(ABORT, 'board_audit is append-only'); END;

-- Invite emails sent per owner per UTC day, for the daily cap (MAX_DAILY_INVITE_EMAILS).
CREATE TABLE invite_sends (
  owner_id TEXT NOT NULL,
  day TEXT NOT NULL,
  sent INTEGER NOT NULL,
  PRIMARY KEY (owner_id, day)
);

-- Whether a shared board is view-only because its owner's Pro lapsed. Kept so the change is
-- written to the audit log once, when it happens, and not on every look.
CREATE TABLE board_sharing (
  owner_id TEXT PRIMARY KEY,
  suspended INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
