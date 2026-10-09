// Many boards per account (// BOARDS in the README). A board is a project: its own cards and
// members, and later its own wiki and files. Each is a TodoAgent Durable Object named by the
// board's id. An account's first board is named by the account's user id and has no row in
// D1, so nothing that existed before boards moves; every board after it is a row in `boards`
// (migrations/0009_boards.sql) with a random id.
//
// This file is the registry: which boards an account owns, their names, and the one way to
// turn an id into "whose board is this". Who may reach a board is still `access` in
// members.ts, which asks here for the owner of any id that isn't the caller's own.

import { currentUser, type User } from "./auth";
import { planFor } from "./billing";
import { BOARD_ID } from "./member-rules";

/** A board as the registry knows it. `first` is the account's original board, the one with no row. */
export type BoardRef = { id: string; ownerId: string; ownerEmail: string; name: string; first: boolean; createdAt: number | null; archivedAt: number | null };

/** What the first board is called. It has no row, so it has no stored name. */
export const FIRST_BOARD_NAME = "My board";
export const BOARD_NAME_MAX = 60;

type BoardRow = { id: string; owner_id: string; owner_email: string; name: string; created_at: number; archived_at: number | null };

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const fail = (status: number, code: string, error: string) => json({ error, code }, status);

/** How many boards one account may own, the first included. */
export function maxBoards(env: Env): number {
  const n = Number((env as { MAX_BOARDS?: string }).MAX_BOARDS);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 20;
}

/** A board's name as stored: one line, trimmed, no control characters, 1 to BOARD_NAME_MAX characters. Null when there's nothing usable. */
export function cleanBoardName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, "").replace(/\s+/g, " ").trim();
  return name && name.length <= BOARD_NAME_MAX ? name : null;
}

/** The id of a new board: 32 hex characters, the same shape as a user id (BOARD_ID). */
function newBoardId(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const fromRow = (r: BoardRow): BoardRef => ({ id: r.id, ownerId: r.owner_id, ownerEmail: r.owner_email, name: r.name, first: false, createdAt: r.created_at, archivedAt: r.archived_at });
const firstBoard = (user: User): BoardRef => ({ id: user.id, ownerId: user.id, ownerEmail: user.email, name: FIRST_BOARD_NAME, first: true, createdAt: null, archivedAt: null });

/**
 * The board an id names. A row in `boards`, or a first board, whose owner is whoever that id
 * belongs to. The owner's email for a first board comes from `users`, which has every account
 * that has signed in. An id nobody has is still answered as a first board with no email: that
 * says nothing about whether it exists, and `access` refuses it the same as any other.
 */
export async function boardById(env: Env, id: string): Promise<BoardRef | null> {
  if (!BOARD_ID.test(id)) return null;
  const row = await env.DB.prepare("SELECT * FROM boards WHERE id = ?").bind(id).first<BoardRow>();
  if (row) return fromRow(row);
  const u = await env.DB.prepare("SELECT email FROM users WHERE user_id = ?").bind(id).first<{ email: string }>();
  return { id, ownerId: id, ownerEmail: u?.email ?? "", name: FIRST_BOARD_NAME, first: true, createdAt: null, archivedAt: null };
}

/** The board `id` if `user` owns it, else null. One D1 read; none at all for the first board. */
export async function ownedBoard(env: Env, user: User, id: string | null | undefined): Promise<BoardRef | null> {
  if (id === null || id === undefined || id === user.id) return firstBoard(user);
  if (!BOARD_ID.test(id)) return null;
  const row = await env.DB.prepare("SELECT * FROM boards WHERE id = ? AND owner_id = ?").bind(id, user.id).first<BoardRow>();
  return row ? fromRow(row) : null;
}

/** Every board the account owns: the first one, then the rest in the order they were made. `archived` includes archived ones. */
export async function ownedBoards(env: Env, user: User, archived = false): Promise<BoardRef[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM boards WHERE owner_id = ? ${archived ? "" : "AND archived_at IS NULL"} ORDER BY created_at LIMIT 200`,
  ).bind(user.id).all<BoardRow>();
  return [firstBoard(user), ...results.map(fromRow)];
}

/**
 * The board a person or an agent means by `key`: an id, or a name among the boards they own
 * (case doesn't matter; the first board answers to "My board"). Nothing, or the account's own
 * id, is the first board. Null when nothing matches.
 */
export async function findOwnedBoard(env: Env, user: User, key: string | undefined | null): Promise<BoardRef | null> {
  if (!key || key === user.id) return firstBoard(user);
  const byId = await ownedBoard(env, user, key);
  if (byId) return byId;
  const want = key.trim().toLowerCase();
  if (!want) return null;
  const boards = await ownedBoards(env, user, true);
  return boards.find((b) => b.name.toLowerCase() === want) ?? null;
}

export async function createBoard(env: Env, user: User, name: string): Promise<BoardRef | "board_limit"> {
  const max = maxBoards(env);
  const id = newBoardId();
  const now = Date.now();
  // The cap is checked inside the insert, so two creates racing can't both squeeze past it.
  const added = await env.DB.prepare(
    `INSERT INTO boards (id, owner_id, owner_email, name, created_at)
     SELECT ?1, ?2, ?3, ?4, ?5 WHERE (SELECT COUNT(*) FROM boards WHERE owner_id = ?2) + 1 < ?6`,
  ).bind(id, user.id, user.email, name, now, max).run();
  if (added.meta.changes !== 1) return "board_limit";
  return { id, ownerId: user.id, ownerEmail: user.email, name, first: false, createdAt: now, archivedAt: null };
}

/**
 * The board API. Everything needs a browser session; the Worker has already refused writes
 * from another origin (fromElsewhere in server.ts). The list itself is `GET /api/boards` in
 * members.ts, which also knows the boards shared with you.
 */
export async function handleBoards(req: Request, env: Env, path: string): Promise<Response | null> {
  if (req.method !== "POST" || !["/api/boards/create", "/api/boards/rename", "/api/boards/archive", "/api/boards/unarchive"].includes(path)) return null;
  const user = await currentUser(req, env);
  if (!user) return json({ error: "signed out" }, 401);
  const raw = await req.json<unknown>().catch(() => null);
  const body = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;

  if (path === "/api/boards/create") {
    const name = cleanBoardName(body.name);
    if (!name) return fail(400, "bad_name", `Give the board a name, up to ${BOARD_NAME_MAX} characters.`);
    // More than one board is part of Pro, like sharing one.
    if ((await planFor(env, user.id)) !== "pro") return fail(402, "pro_required", "More than one board is part of Pro. Upgrade to add a board.");
    const made = await createBoard(env, user, name);
    if (made === "board_limit") return fail(409, "board_limit", `An account can have ${maxBoards(env)} boards. Archive one first.`);
    return json({ board: made }, 201);
  }

  const board = typeof body.board === "string" ? await ownedBoard(env, user, body.board) : null;
  // The same answer for a board that isn't there and one that isn't yours.
  if (!board) return fail(404, "not_found", "No such board.");
  if (board.first) return fail(400, "first_board", path === "/api/boards/rename" ? "Your first board is always called My board." : "Your first board can't be archived.");

  if (path === "/api/boards/rename") {
    const name = cleanBoardName(body.name);
    if (!name) return fail(400, "bad_name", `Give the board a name, up to ${BOARD_NAME_MAX} characters.`);
    await env.DB.prepare("UPDATE boards SET name = ? WHERE id = ? AND owner_id = ?").bind(name, board.id, user.id).run();
    return json({ board: { ...board, name } });
  }
  const archivedAt = path === "/api/boards/archive" ? Date.now() : null;
  await env.DB.prepare("UPDATE boards SET archived_at = ? WHERE id = ? AND owner_id = ?").bind(archivedAt, board.id, user.id).run();
  return json({ board: { ...board, archivedAt } });
}
