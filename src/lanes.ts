// Which lanes are special. A board has up to three: where new work lands (to do), where work in
// progress sits (doing), and where finished cards go (done). A lane holds its role in `role`, so
// the lanes can be dragged into any order, or renamed, without changing what "done" means.
//
// Boards from before roles have none stored. For those the roles are read off the lane names
// ("To do", "Doing", "Done"), and failing that off position, which is the rule the app used to
// have: the first lane takes new cards and the last lane is done. The first time such a board's
// lanes change (add, rename, delete, move, or a role handed over) the answer is written onto the
// lanes (stampRoles), and from then on only the stored roles count.
//
// On an encrypted board the server sees lane names as ciphertext, so there the reading falls
// back to position; `role` itself isn't encrypted, the same as a lane's sort.

export type LaneRole = "todo" | "doing" | "done";

/** The roles in the order the lane menu lists them. `label` names the role; `say` is how a sentence refers to the lane. */
export const LANE_ROLES = [
  { role: "todo", label: "To do", say: "the to do lane" },
  { role: "doing", label: "Doing", say: "the doing lane" },
  { role: "done", label: "Done", say: "the done lane" },
] as const satisfies readonly { role: LaneRole; label: string; say: string }[];

/** As much of a lane as the rules need. */
export type RoleLane = { id: string; name: string; role?: LaneRole };

const NAMED: Record<LaneRole, RegExp> = {
  todo: /^to[\s-]?do$/i,
  doing: /^(doing|in progress)$/i,
  done: /^done$/i,
};

/** Roles for a board that has none stored: by lane name, then by position. One lane never gets two. */
function readRoles(lanes: readonly RoleLane[]): Partial<Record<LaneRole, string>> {
  const out: Partial<Record<LaneRole, string>> = {};
  const free = (l: RoleLane | undefined): l is RoleLane => !!l && !Object.values(out).includes(l.id);
  for (const role of ["done", "todo", "doing"] as const) {
    const named = lanes.find((l) => NAMED[role].test(l.name.trim()) && free(l));
    if (named) out[role] = named.id;
  }
  const last = lanes[lanes.length - 1];
  // A board with one lane has nowhere to finish a card.
  if (!out.done && lanes.length > 1 && free(last)) out.done = last.id;
  if (!out.todo && free(lanes[0])) out.todo = lanes[0].id;
  if (!out.doing && lanes.length === 3 && free(lanes[1])) out.doing = lanes[1].id;
  return out;
}

/** The lane id holding each role. A role nobody holds is missing. */
export function laneRoles(lanes: readonly RoleLane[]): Partial<Record<LaneRole, string>> {
  if (!lanes.some((l) => l.role)) return readRoles(lanes);
  const out: Partial<Record<LaneRole, string>> = {};
  for (const l of lanes) if (l.role && !out[l.role]) out[l.role] = l.id;
  return out;
}

/** The role a lane holds, if any. */
export function roleOf(lanes: readonly RoleLane[], laneId: string): LaneRole | undefined {
  const roles = laneRoles(lanes);
  return LANE_ROLES.find((r) => roles[r.role] === laneId)?.role;
}

/** The done lane's id, or null when the board has none (one lane, or the done lane was deleted). */
export const doneLaneId = (lanes: readonly RoleLane[]): string | null => laneRoles(lanes).done ?? null;

/** Where new and reopened cards go: the to do lane, or the first lane on a board without one. */
export const todoLaneId = (lanes: readonly RoleLane[]): string | null => laneRoles(lanes).todo ?? lanes[0]?.id ?? null;

/** Write the roles onto the lanes, so later changes to order or names can't shift them. Lanes that already carry roles come back as they are. */
export function stampRoles<L extends RoleLane>(lanes: readonly L[]): L[] {
  if (lanes.some((l) => l.role)) return [...lanes];
  const roles = readRoles(lanes);
  return lanes.map((l) => {
    const role = LANE_ROLES.find((r) => roles[r.role] === l.id)?.role;
    return role ? { ...l, role } : l;
  });
}
