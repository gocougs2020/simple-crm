/**
 * When an open page asks whether anything changed (src/components/live-updates.tsx).
 * Pure, so it's tested and the cost stays predictable: only visible tabs that
 * someone used lately ask, at most once per `pollSeconds`.
 */
export function liveCheckDue({ now, lastCheck, lastActive, visible, pollSeconds, idleMinutes }: { now: number; lastCheck: number; lastActive: number; visible: boolean; pollSeconds: number; idleMinutes: number }) {
  if (!visible || pollSeconds <= 0) return false;
  if (now - lastActive > idleMinutes * 60_000) return false;
  return now - lastCheck >= pollSeconds * 1000;
}
