/** Hold selected ink in time while the live marker advances across it.
 * Only scroll at the right edge; after settlement, ease back to live time. */
export function drawingCameraAt(
  previous: number | null,
  now: number,
  engaged: boolean,
  maxAdvanceMs: number,
  dt: number,
  reducedMotion = false,
): number {
  if (previous === null || previous > now) return now;
  const edge = now - Math.max(0, maxAdvanceMs);
  if (engaged) return Math.max(previous, edge);
  const eased = previous + (now - previous) * (reducedMotion ? 1 : -Math.expm1(-0.004 * dt));
  return Math.max(edge, now - eased < 1 ? now : eased);
}
