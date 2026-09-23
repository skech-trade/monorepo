/**
 * The rules of the points game, with nothing to query: who may be called
 * what, what a drawing has to be, and what a prediction is worth.
 */

import { directionAt, type Pt, shapeOf } from "@skech/core/shape";

export const LEVELS = [0, 100, 250, 500, 1000, 2000];
const RESERVED = new Set(["admin", "support", "skech", "official", "system", "api", "moderator"]);

/** Most points a drawing may send: far more than a hand makes once simplified. */
const MAX_POINTS = 256;

export function usernameOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim().toLowerCase();
  return /^[a-z][a-z0-9_]{2,19}$/.test(name) && !RESERVED.has(name) ? name : null;
}

export function levelOf(points: number) {
  const level = LEVELS.filter((n) => points >= n).length;
  return { level, nextLevelAt: LEVELS[level] ?? null };
}

/**
 * Whether a browser sent a drawing: from the start of the round to its end,
 * forward in time, at real prices. Anything else is refused before it is
 * stored, because it is scored later against candles nobody can take back.
 */
export function isDrawing(pts: unknown): pts is Pt[] {
  if (!Array.isArray(pts) || pts.length < 2 || pts.length > MAX_POINTS) return false;
  if (!pts.every((p) => typeof p === "object" && p !== null)) return false;
  if (pts[0].t !== 0 || pts.at(-1).t !== 1) return false;
  return pts.every(
    (p, i) =>
      Number.isFinite(p.t) &&
      Number.isFinite(p.price) &&
      p.price > 0 &&
      p.t >= 0 &&
      p.t <= 1 &&
      (i === 0 || p.t > pts[i - 1].t),
  );
}

export type Candle = { t: number; o: number; c: number };

/**
 * How much of the market's movement the drawing called: each candle's move
 * counts toward accuracy when the drawing faced that way at that candle.
 * Points are flat for taking part, plus a bonus for a sharp call; there is no
 * stake or leverage to multiply them.
 */
export function scorePrediction(pts: Pt[], entry: number, bars: Candle[]) {
  const shape = shapeOf(pts, entry);
  if (!shape || shape.flat || !bars.length) return null;
  let correct = 0;
  let movement = 0;
  bars.forEach((bar, i) => {
    const delta = bar.c - (i ? bars[i - 1].c : entry);
    movement += Math.abs(delta);
    if (directionAt(shape.legs, i, bars.length) * delta > 0) correct += Math.abs(delta);
  });
  const accuracy = movement > 0 ? correct / movement : 0;
  return { accuracy, points: 20 + (movement > 0 && accuracy >= 0.7 ? 10 : 0) };
}
