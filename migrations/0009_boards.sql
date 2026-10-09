-- Many boards per account (src/boards.ts). A board is a project: its own cards, members,
-- and later its own wiki and files. Each is a TodoAgent Durable Object named by the board's
-- id, which is also the key under which its attachments, claims, and members are stored.
--
-- An account's first board has no row here: its id is the account's user id, as it always was,
-- so nothing that exists moves. Every board made after that gets a row with a random id, and
-- `access` (src/members.ts) reads the owner from here for any id that isn't the caller's own.
--
-- board_members.owner_id, board_audit.owner_id, board_sharing.owner_id, and invite_sends.owner_id
-- all hold the board's id. They were named when a board's id and its owner's were the same
-- thing; for a first board they still are. The owner of any other board is this table's
-- owner_id, and the plan that governs a board is its owner's.
CREATE TABLE boards (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  owner_email TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  -- Archived boards stay reachable by id and keep their members; they're left out of lists and
  -- of "all my tasks". Nothing is deleted.
  archived_at INTEGER
);
CREATE INDEX boards_owner ON boards (owner_id, created_at);
