import { directionAt, shapeOf, type Pt } from "@skech/core/shape";
export const LEVELS = [0, 100, 250, 500, 1000, 2000];
const RESERVED = new Set(["admin", "support", "skech", "official", "system", "api", "moderator"]);
export function usernameOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim().toLowerCase();
  return /^[a-z][a-z0-9_]{2,19}$/.test(name) && !RESERVED.has(name) ? name : null;
}
export function levelOf(points: number) {
  const level = LEVELS.filter(n => points >= n).length;
  return { level, nextLevelAt: LEVELS[level] ?? null };
}
export type Candle = { t: number; o: number; c: number };
export function scorePrediction(pts: Pt[], entry: number, bars: Candle[]) {
  const shape = shapeOf(pts, entry);
  if (!shape || shape.flat || !bars.length) return null;
  let correct = 0, movement = 0;
  bars.forEach((bar, i) => {
    const delta = bar.c - (i ? bars[i - 1].c : entry);
    movement += Math.abs(delta);
    if (directionAt(shape.legs, i, bars.length) * delta > 0) correct += Math.abs(delta);
  });
  const accuracy = movement > 0 ? correct / movement : 0;
  return { accuracy, points: 20 + (movement > 0 && accuracy >= 0.7 ? 10 : 0) };
}
