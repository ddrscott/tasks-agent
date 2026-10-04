-- Card deletions on a shared board (src/members.ts, logCards). A deleted card has no face left
-- to show a name on, so who deleted it, when, its title, and the lane it was in go in the
-- board's audit log, next to the membership events. `detail` is JSON:
--   {"card":"c1a2b","title":"Ship the invoice","lane":"To do","via":"assistant"}
-- `via` is there when it wasn't done by hand: "assistant", "agent" (the owner's, over MCP),
-- "undo", or "redo". NULL on membership rows. Adding a column isn't an UPDATE, so the
-- append-only triggers from 0005 still refuse every change to a row that's there.
ALTER TABLE board_audit ADD COLUMN detail TEXT;
