// The board switcher, in the top bar next to the wordmark: your boards (the first, then the
// ones you made, // BOARDS in the README), and each board someone shared with you, as its
// name and your role, or its owner's email when it's their first board (// TEAM_BOARDS). It's always drawn, even for someone with one
// board and nothing shared: it names the board the section nav beside it (SectionNav.tsx) is
// about, and New board… is in it. The list comes from `GET /api/boards` and is read again
// each time the menu opens. Which board is open lives in the address
// (`/tasks/?board=<id>`), so a reload or a bookmark comes back to it; the id opens nothing by itself.

import { useState } from "react";
import { Popover } from "./Board";
import { boardName, roleWord, sharedName, type Boards, type MemberAccess } from "./member";

const IconBoards = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" aria-hidden="true">
    <rect x="3" y="4" width="7" height="16" /><rect x="14" y="4" width="7" height="10" />
  </svg>
);

type Props = {
  boards: Boards | null;
  myId: string;
  /** The shared board on screen, or null. Its live access, which the socket keeps current. */
  access: MemberAccess | null;
  /** A board of yours after the first, when it's the one on screen. Null on your first board and on a shared one. */
  own: string | null;
  /** null is your first board. */
  onSwitch(board: string | null): void;
  /** The menu is about to open: a good time to read the list again. */
  onOpen(): void;
  /** Make a board (the account menu's New board…). */
  onNew(): void;
  /** Set on the All boards page (AllBoards.tsx), where no one board is current. */
  all?: boolean;
  /** Open the All boards page. */
  onAll(): void;
};

export function BoardSwitcher({ boards, myId, access, own, onSwitch, onOpen, onNew, all, onAll }: Props) {
  const [open, setOpen] = useState(false);
  const shared = boards?.shared ?? [];
  const mine = (boards?.mine ?? []).filter((b) => !b.archived || b.board === own);
  const current = all ? "all" : access?.board ?? own ?? null;
  const name = all ? "All boards" : access ? sharedName(boards, access) : boardName(boards, own, myId);
  // A named board says its name; a first board has only its owner's email, so it reads as theirs.
  const named = !!access && name !== access.ownerEmail;
  // The open board's row uses what its socket last said, which can be newer than the list.
  const rows = shared.map((b) => (access && b.board === access.board ? { ...b, ...access } : b));
  if (access && !rows.some((b) => b.board === access.board)) rows.push({ ...access, name: "", plan: "pro", since: null });
  const pick = (board: string | null) => { setOpen(false); if (board !== current) onSwitch(board); };

  return (
    <div className="anchor board-switch">
      <button
        className="btn board-switch-btn" aria-haspopup="menu" aria-expanded={open}
        title="Switch boards" aria-label={`${access ? `${named ? `${name}, ${access.ownerEmail}'s board` : `${name}'s board`}, ${roleWord(access)}` : name}. Switch boards`}
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
            {/* Once there's more than one board, every board on one screen (// ALL_BOARDS). */}
            {(mine.length > 0 || shared.length > 0 || all) && (
              <button role="menuitemradio" aria-checked={current === "all"} onClick={() => { setOpen(false); if (current !== "all") onAll(); }}>
                <span className="board-row">
                  <span className="board-row-name">All boards</span>
                  <span className="board-row-sub">every card you can reach, by To do, Doing, Done</span>
                </span>
              </button>
            )}
            <div className="menu-label h">MY_BOARDS</div>
            <button role="menuitemradio" aria-checked={current === null} onClick={() => pick(null)}>
              <span className="board-row">
                <span className="board-row-name">My board</span>
                <span className="board-row-sub">{boards?.own.email ?? "yours"}</span>
              </span>
            </button>
            {mine.map((b) => (
              <button key={b.board} role="menuitemradio" aria-checked={current === b.board} onClick={() => pick(b.board)}>
                <span className="board-row">
                  <span className="board-row-name">{b.name}</span>
                  {b.archived && <span className="board-row-sub">archived</span>}
                </span>
              </button>
            ))}
            <button role="menuitem" onClick={() => { setOpen(false); onNew(); }}>New board…</button>
            {rows.length > 0 && <div className="menu-label h">SHARED_WITH_ME</div>}
            {rows.map((b) => (
              <button key={b.board} role="menuitemradio" aria-checked={current === b.board} onClick={() => pick(b.board)}>
                <span className="board-row">
                  <span className="board-row-name">{b.name ? `${b.name} · ${b.ownerEmail}` : b.ownerEmail}</span>
                  <span className="board-row-sub">
                    <span className="role-chip" data-role={b.effective}>{b.role}</span>
                    {b.reason === "plan_lapsed" && <span>view only: the owner's Pro plan isn't active</span>}
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
