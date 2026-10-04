-- So someone who opens their invite email again after accepting is told "you're already on
-- this board" instead of "this invite can't be used" (lookup in src/members.ts).
-- Accepting moves the token's hash from token_hash to here in the same statement. It never
-- opens anything again: accept and decline only ever match token_hash on a pending row, and
-- this column is only read together with the signed-in member's own id and email, on a row
-- that's still accepted. Anyone else, and the same person after leaving or being removed
-- (which deletes the row), gets the one refusal every unusable invite gets.
ALTER TABLE board_members ADD COLUMN used_token_hash TEXT;
CREATE INDEX board_members_used_token ON board_members (used_token_hash) WHERE used_token_hash IS NOT NULL;
