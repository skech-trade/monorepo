import { DIFFICULTY, MIN_DIFFICULTY } from "./dots";

/**
 * The thirty-second paper run: "Try it free" for someone signed out. Ten
 * dollars of paper money, the live price, the real game screen, and nothing
 * sent anywhere: no relayer, no chain, no wallet.
 *
 * The odds are easier than real play, and say so on a pill that never
 * leaves the screen. Easier is one setting, `PAPER_DIFFICULTY`, under the
 * least real play allows (`MIN_DIFFICULTY`): every section is priced and paid
 * by the same `ladderSection` at that setting, so the multiple on the map is
 * the multiple a hit pays. There are no fees on paper.
 *
 * Calibrated with `scripts/check-paper.ts` on Coinbase BTC-USD, October 7–9
 * 2026 (861 moments, three screens, three pens, six strokes drawn near the
 * price; the library is September 1–16). Whether the price touches a stroke
 * is the market's, the same at every setting: 60% of those strokes were
 * touched, 74–79% of those drawn from, along or across the price. What the
 * setting moves is what a touch pays. At 55, real play's, they returned 78¢
 * a dollar and 29% of them came out ahead; at 0, the paper run's, 96¢ and
 * 33%. Easier, close to even, and still not a dollar back for every dollar.
 *
 * Pure functions over a plain record, on the caller's clock (a monotonic one:
 * `performance.now()`), so the web and the phone run the same rules and the
 * tests can drive the clock.
 */

/** How long a run lasts, in ms. */
export const PAPER_MS = 30_000;
/** The paper money a run starts with. */
export const PAPER_START = 10;
/**
 * What a dot costs on paper, fixed for the run: a cent, so ten dollars lasts many strokes in thirty seconds
 * and a first run sees hits and misses, not one stroke spending it all. Real play's least is 10¢.
 */
export const PAPER_PER_DOT = 0.01;
/** The last seconds, when the pill turns urgent. */
export const PAPER_URGENT_MS = 5000;
/** Once the last ink has settled, how long its result shows before the end card. */
export const PAPER_LINGER_MS = 1600;
/** The longest a run waits for its ink to settle after the clock runs out: ink reaches 31 s ahead. */
export const PAPER_SETTLE_MAX_MS = 40_000;
/**
 * How hard the paper run is: 0, the easy end of the scale `difficulty` is written for, where real play is
 * never under MIN_DIFFICULTY (50). Ink exactly on a rung returns `ladderBest`, 1.20 − 0.40 × d/100: $1.20
 * here, 98¢ at real play's 55.
 */
export const PAPER_DIFFICULTY = 0;

export type PaperPhase = "running" | "settling" | "over";

export type PaperRun = {
  phase: PaperPhase;
  /** What was left on the clock when it was last stopped or started. */
  leftMs: number;
  /** When the clock was last started; null while it is stopped (paused, or run out). */
  since: number | null;
  /** When the clock ran out, and when the last ink settled after it. */
  endedAt: number | null;
  settledAt: number | null;
  balance: number;
  /** What hits have paid into the balance, this run. */
  won: number;
  /** Drawings placed this run. */
  drawings: number;
};

const cents = (n: number) => Math.round(n * 100) / 100;

export function startPaper(now: number): PaperRun {
  return { phase: "running", leftMs: PAPER_MS, since: now, endedAt: null, settledAt: null, balance: PAPER_START, won: 0, drawings: 0 };
}

/** What is left on the clock, in ms. */
export const leftOf = (run: PaperRun, now: number) => (run.phase !== "running" ? 0 : Math.max(0, run.since === null ? run.leftMs : run.leftMs - (now - run.since)));

/** Whether ink can go in: only while the clock runs. A paused run takes none. */
export const canDraw = (run: PaperRun | null, now: number) => run !== null && run.phase === "running" && run.since !== null && leftOf(run, now) > 0;

/** The last seconds. */
export const urgent = (run: PaperRun, now: number) => run.phase === "running" && leftOf(run, now) <= PAPER_URGENT_MS;

/** The clock as the pill shows it: whole seconds, rounded up, so it reads 0:30 at the start and 0:00 only at the end. */
export function clockText(ms: number) {
  const s = Math.ceil(Math.max(0, ms) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The page is hidden or the app is in the background: the clock stops where it is. */
export function pausePaper(run: PaperRun, now: number): PaperRun {
  if (run.phase !== "running" || run.since === null) return run;
  return { ...run, leftMs: leftOf(run, now), since: null };
}

/** Back on screen: the clock goes on from where it stopped. */
export function resumePaper(run: PaperRun, now: number): PaperRun {
  if (run.phase !== "running" || run.since !== null) return run;
  return { ...run, since: now };
}

/**
 * Move the run on. `open`: whether any of its ink is still unsettled (or still under the pen). The clock running
 * out stops the ink; the run is over once what was drawn has settled and its result has had a moment on screen.
 */
export function stepPaper(run: PaperRun, now: number, open: boolean): PaperRun {
  if (run.phase === "running") {
    if (run.since === null || leftOf(run, now) > 0) return run;
    run = { ...run, phase: "settling", leftMs: 0, since: null, endedAt: now };
  }
  if (run.phase === "settling") {
    const waited = now - (run.endedAt ?? now);
    if (waited >= PAPER_SETTLE_MAX_MS) return { ...run, phase: "over" };
    if (open) return run.settledAt === null ? run : { ...run, settledAt: null };
    if (run.settledAt === null) return { ...run, settledAt: now };
    if (now - run.settledAt >= PAPER_LINGER_MS) return { ...run, phase: "over" };
  }
  return run;
}

/** A drawing's cost, out of the paper money: null when there is not enough of it, and nothing is taken. */
export function debitPaper(run: PaperRun, amount: number): PaperRun | null {
  if (amount > run.balance + 1e-9) return null;
  return { ...run, balance: cents(run.balance - amount) };
}

/** Money back into the paper balance: `won` of it paid by hits, the rest ink that came back unpriced. */
export function creditPaper(run: PaperRun, amount: number, won = 0): PaperRun {
  return { ...run, balance: cents(run.balance + amount), won: cents(run.won + won) };
}

/** What the run came to: the end card's line, and the change in paper money. */
export function paperResult(run: Pick<PaperRun, "balance" | "drawings">, money: (n: number) => string): { pnl: number; headline: string } {
  const pnl = cents(run.balance - PAPER_START);
  const seconds = Math.round(PAPER_MS / 1000);
  const start = money(PAPER_START);
  if (run.drawings === 0) return { pnl, headline: "You didn’t draw this time" };
  if (pnl > 0) return { pnl, headline: `You turned ${start} into ${money(run.balance)} in ${seconds} seconds` };
  if (pnl < 0) return { pnl, headline: `Your ${start} came to ${money(run.balance)} in ${seconds} seconds` };
  return { pnl, headline: `You kept your ${start} in ${seconds} seconds` };
}

/**
 * The setting a drawing placed now is priced at, and the least it may be: the chain's on chain, the house's
 * slider or the game's own in practice, and the paper run's while one is on. Only the paper run goes under
 * MIN_DIFFICULTY; every other source is held to it, as `difficulty` always has.
 */
export function levelFor({ paper, chain, house }: { paper: boolean; chain?: number | null; house?: number | null }): { level: number; least: number } {
  if (paper) return { level: PAPER_DIFFICULTY, least: PAPER_DIFFICULTY };
  return { level: chain ?? house ?? DIFFICULTY, least: MIN_DIFFICULTY };
}
