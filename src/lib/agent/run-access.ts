/**
 * Whether a background run's token may act right now, from what one read of
 * its run and teammate found. Pure, so the refusals are tested: a run that
 * isn't going (finished, cancelled, or not this teammate's) and a teammate
 * who was deactivated are both turned away.
 */
export function runAccess(row: { status: string; deactivatedAt: Date | null } | undefined): { ok: true } | { ok: false; message: string } {
  if (!row || row.status !== "running") return { ok: false, message: "That background task has ended, so it can't read or change anything more." };
  if (row.deactivatedAt) return { ok: false, message: "The teammate this background task works for was deactivated." };
  return { ok: true };
}
