// The board switcher, in the top bar next to the wordmark: your own board, and each board
// someone shared with you, as its owner's email and your role (// TEAM_BOARDS in the README).
// It isn't drawn at all for someone with no shared boards, so a solo board's top bar is the
// one it always had. The list comes from `GET /api/boards` and is read again each time the
// menu opens. Which board is open lives in the address (`/tasks/?board=<owner id>`), so a
// reload or a bookmark comes back to it; the id opens nothing by itself.

import { useState } from "react";
import { Popover } from "./Board";
import { roleWord, type Boards, type MemberAccess } from "./member";

const IconBoards = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" aria-hidden="true">
    <rect x="3" y="4" width="7" height="16" /><rect x="14" y="4" width="7" height="10" />
  </svg>
);

type Props = {
  boards: Boards | null;
  /** The shared board on screen, or null on your own. Its live access, which the socket keeps current. */
  access: MemberAccess | null;
  /** null is your own board. */
  onSwitch(board: string | null): void;
  /** The menu is about to open: a good time to read the list again. */
  onOpen(): void;
};

export function BoardSwitcher({ boards, access, onSwitch, onOpen }: Props) {
  const [open, setOpen] = useState(false);
  const shared = boards?.shared ?? [];
  if (!access && !shared.length) return null;
  const name = access ? access.ownerEmail : "My board";
  // The open board's row uses what its socket last said, which can be newer than the list.
  const rows = shared.map((b) => (access && b.board === access.board ? { ...b, ...access } : b));
  if (access && !rows.some((b) => b.board === access.board)) rows.push({ ...access, plan: "pro", since: null });
  const pick = (board: string | null) => { setOpen(false); if (board !== (access?.board ?? null)) onSwitch(board); };

  return (
    <div className="anchor board-switch">
      <button
        className="btn board-switch-btn" aria-haspopup="menu" aria-expanded={open}
        title="Switch boards" aria-label={`${access ? `${name}'s board, ${roleWord(access)}` : "My board"}. Switch boards`}
        onClick={() => { if (!open) onOpen(); setOpen((o) => !o); }}
      >
        <IconBoards />
        <span className="hide-sm label board-switch-name">{name}</span>
        {access && <span className="hide-sm label role-chip" data-role={access.effective}>{roleWord(access)}</span>}
        <span className="board-switch-caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <Popover menu label="Boards" onClose={() => setOpen(false)}>
          <div className="menu board-menu">
            <div className="menu-label">Boards</div>
            <button role="menuitemradio" aria-checked={!access} onClick={() => pick(null)}>
              <span className="board-row">
                <span className="board-row-name">My board</span>
                <span className="board-row-sub">{boards?.own.email ?? "yours"}</span>
              </span>
            </button>
            <div className="menu-label">Shared with me</div>
            {rows.map((b) => (
              <button key={b.board} role="menuitemradio" aria-checked={access?.board === b.board} onClick={() => pick(b.board)}>
                <span className="board-row">
                  <span className="board-row-name">{b.ownerEmail}</span>
                  <span className="board-row-sub">
                    <span className="role-chip" data-role={b.effective}>{b.role}</span>
                    {b.reason === "plan_lapsed" && <span>view only: the owner's plan lapsed</span>}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </Popover>
      )}
    </div>
  );
}
