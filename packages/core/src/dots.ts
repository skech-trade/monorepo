/**
 * skech: paint dots ahead of the price. Every dot the price passes through pays.
 *
 * The space ahead of now is a field of dots: one second wide, one price step
 * tall. You paint over them, and every dot you paint is a bet of the same
 * size, set by you (a dime a dot, say). So a drawing costs its area. A dot
 * pays its own multiple when the price passes through it: dots close to the
 * price, and soon, are likely and pay a little; dots far from it, in price
 * or in time, are unlikely and pay a lot.
 *
 * How likely is measured, not modelled: the field is laid over thousands of
 * real thirty-second stretches of Bitcoin, taken from moments that looked
 * like this one (as busy, moving the same way), and the share of them that
 * passed through a dot is its chance. A dot pays `rtp / chance`, so every
 * dot returns the same on average wherever it is: the house keeps the same
 * share of a long shot as of a sure thing.
 *
 * Time runs in whole seconds, as the price data does. A drawing opens on the
 * second after it is placed and is priced there, on everything known by
 * then. The second after that is never part of it, so nobody can react
 * faster than the bet. A dot is hit when its second's trades reach its step.
 *
 * Pure functions over plain data: the page runs it for free play, and the
 * server can run the same code once there is money in it.
 */

export const RULES = {
  /**
   * What a dot returns per dollar on average, by the paths; the house keeps
   * the rest. On days the paths never saw it comes out lower still: at 0.85,
   * 0.62 to 0.88 a dollar by day on 17-23 September, so the house keeps a
   * tenth even on its worst day, and more on the rest, for the day a crash
   * pays out more than it takes. `check-ink.ts` says what it comes to.
   */
  rtp: 0.85,
  /** Taken off the return for each unit of momentum, on the side the price just moved towards: see `rtpAt`. */
  momentumMargin: 0.11,
  /** Seconds ahead a dot may be. */
  horizon: 30,
  /** Under this a spot is nearly certain and is not offered. Low, so ink right by the price still pays a little rather than leaving a hole there. */
  minMultiple: 1.01,
  /** Over this it is not offered: the chance is too small to measure well, and one lucky hit on it is what the house has to have put by. */
  maxMultiple: 50,
  /** Drawings in play at once. */
  maxOpen: 5,
  /** Dots in one drawing. */
  maxDots: 400,
  /** How the one-second volatility is read: the five minutes before. */
  volWindowMs: 300_000,
  /** How tall a dot is, in the market's typical one-second moves. */
  stepSigmas: 1.2,
} as const;

/** What one dot costs, in practice dollars. The first is the default. */
export const DOT_BETS = [0.1, 0.25, 0.5, 1] as const;
export const START_BALANCE = 1000;

export type Bar = { t: number; h: number; l: number; c: number };
/**
 * What a moment is priced on: the price, how busy the market is (`sigma`),
 * which way it has just moved (`momentum`) and how far it swings inside a
 * second beyond its moves between seconds (`wick`). The last matters for
 * dots, which are small: on days as busy as each other, one swung a fifth
 * more inside each second than another, and its dots were hit that much
 * more often.
 */
export type Features = { sigma: number; momentum: number; price: number; wick: number };

/**
 * A dot: its second (ms, from the feed's clock) and its price row, from
 * `row * step` up to but not including `(row + 1) * step`. A price exactly
 * on the line between two rows is in the upper one only: prices sit on
 * round numbers often, and counted in both, the row under the price was hit
 * twice as often as it was priced.
 */
export type Dot = { t: number; row: number };
export type DotStatus = "live" | "hit" | "miss";
export type BetDot = Dot & { multiple: number; status: DotStatus; paid?: number };

export type BetStatus = "opening" | "live" | "done" | "void";
export type Bet = {
  id: string;
  placedAt: number;
  /** The second it opens and is priced on. */
  openAt: number;
  /** What each dot costs. */
  perDot: number;
  step: number;
  /** As painted, before it opened. */
  painted: Dot[];
  /** As priced: the dots on offer when it opened, each with its multiple. */
  dots: BetDot[];
  status: BetStatus;
  /** Why it was voided, if it was. */
  why?: string;
  /**
   * The stroke as it was drawn, for the picture only: what is bet is
   * `painted`. Points in time and price from `t0` and `p0`, and the pen's
   * half-width in each, so it draws the same whatever the zoom.
   */
  stroke?: Stroke;
};

export type Stroke = { t0: number; p0: number; pts: { t: number; p: number }[]; rt: number; rp: number };

/* ------------------------------------------------------------------ */
/* How busy the market is, and which way it is going                   */
/* ------------------------------------------------------------------ */

export const SIGMA_DEFAULT = 6.85e-5;
const SIGMA_MIN = 5e-6;
const SIGMA_MAX = 3e-4;

/**
 * Volatility per second, as a fraction of price, from the closes of the five
 * minutes before `at` (a second boundary): the spread of five-second moves,
 * scaled to one second. Five, not one: from second to second the price
 * rattles between buyers and sellers, which makes a market look busier than
 * it is over the seconds a dot is ahead. Priced on one-second moves, a dot
 * on the price in a quiet market paid as if it were hit one time in ten; it
 * was hit four in ten. Clamped, so a frozen feed cannot make everything 100x.
 */
export function volatility(bars: Bar[], at: number): number {
  const from = at - RULES.volWindowMs;
  const bySecond = new Map<number, number>();
  for (const b of bars) if (b.t >= from && b.t < at) bySecond.set(Math.floor(b.t / 1000), b.c);
  let n = 0;
  let sum = 0;
  let sq = 0;
  for (const [sec, c] of bySecond) {
    const before = bySecond.get(sec - VOL_LAG);
    if (before === undefined) continue;
    const r = Math.log(c / before);
    n++;
    sum += r;
    sq += r * r;
  }
  if (n < 30) return SIGMA_DEFAULT;
  const sd = Math.sqrt(Math.max(0, sq / n - (sum / n) ** 2) / VOL_LAG);
  return Math.min(SIGMA_MAX, Math.max(SIGMA_MIN, sd));
}
/** The move volatility is read on, in seconds. */
export const VOL_LAG = 5;

/**
 * Everything a bet opening at `at` is priced on: the price as the second
 * before closed, the volatility, and the last three seconds' move in units
 * of that volatility over three seconds. Null until those seconds exist.
 */
export function features(bars: Bar[], at: number): Features | null {
  const closeOf = (t: number) => {
    for (let i = bars.length - 1; i >= 0; i--) if (bars[i].t === t) return bars[i].c;
    return null;
  };
  const price = closeOf(at - 1000);
  const then = closeOf(at - 4000);
  if (!price || !then) return null;
  const sigma = volatility(bars, at);
  return { price, sigma, momentum: Math.log(price / then) / (sigma * Math.sqrt(3)), wick: wickOf(bars, at, sigma) };
}

/**
 * How far the price swings inside a second, beyond the move from the last
 * close to this one, over the minute before `at`: per bar, how far the high
 * went past the higher of the two closes plus how far the low went past the
 * lower, as a fraction of price, averaged, in volatilities.
 */
export function wickOf(bars: Bar[], at: number, sigma: number): number {
  let n = 0;
  let sum = 0;
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i];
    const prev = bars[i - 1];
    if (b.t < at - WICK_MS || b.t >= at || b.t - prev.t !== 1000) continue;
    n++;
    sum += excursion(prev.c, b) / b.c;
  }
  return n < 20 ? WICK_DEFAULT : Math.max(0.01, sum / n / sigma);
}
/** A bar's reach past its two closes, in price. */
export const excursion = (prevClose: number, b: Bar) => Math.max(0, b.h - Math.max(prevClose, b.c)) + Math.max(0, Math.min(prevClose, b.c) - b.l);
export const WICK_MS = 60_000;
const WICK_DEFAULT = 0.15;

/* ------------------------------------------------------------------ */
/* The paths the chances are measured on                               */
/* ------------------------------------------------------------------ */

/**
 * Real thirty-second stretches of Bitcoin. For each: the volatility,
 * momentum and in-second swing it started with; and each second's close,
 * as a log move from the starting price in units of its own volatility
 * times 100, with how far that second's high and low went past its two
 * closes, in twentieths of a volatility.
 *
 * The swing is kept apart from the closes so it can be scaled: a path from
 * a moment that swung half as much inside each second is priced now with
 * its swings doubled. Matching on it instead left too few paths like now to
 * measure with.
 *
 * Second 0 is the second a bet opens in: never part of a bet, but where
 * second 1 starts from.
 *
 * Binary layout, little-endian: "SKRL", u32 version (3), u32 paths, u32
 * seconds (with second 0), then per path f32 ln(sigma), f32 momentum, f32 wick, and per
 * second i16 close, u8 up, u8 down.
 */
export type Library = { n: number; seconds: number; lnSigma: Float32Array; momentum: Float32Array; wick: Float32Array; close: Int16Array; up: Uint8Array; down: Uint8Array };
export const LIB_SCALE = 100;
export const SWING_SCALE = 20;

export function readLibrary(bytes: Uint8Array): Library {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== "SKRL" || v.getUint32(4, true) !== 3) throw new Error("Not a dots library");
  const n = v.getUint32(8, true);
  const seconds = v.getUint32(12, true);
  const lib: Library = { n, seconds, lnSigma: new Float32Array(n), momentum: new Float32Array(n), wick: new Float32Array(n), close: new Int16Array(n * seconds), up: new Uint8Array(n * seconds), down: new Uint8Array(n * seconds) };
  let o = 16;
  for (let i = 0; i < n; i++) {
    lib.lnSigma[i] = v.getFloat32(o, true);
    lib.momentum[i] = v.getFloat32(o + 4, true);
    lib.wick[i] = v.getFloat32(o + 8, true);
    o += 12;
    for (let j = 0; j < seconds; j++, o += 4) {
      lib.close[i * seconds + j] = v.getInt16(o, true);
      lib.up[i * seconds + j] = bytes[o + 2];
      lib.down[i * seconds + j] = bytes[o + 3];
    }
  }
  return lib;
}

export function writeLibrary(lib: Library): Uint8Array {
  const out = new Uint8Array(16 + lib.n * (12 + lib.seconds * 4));
  const v = new DataView(out.buffer);
  out.set([83, 75, 82, 76]);
  v.setUint32(4, 3, true);
  v.setUint32(8, lib.n, true);
  v.setUint32(12, lib.seconds, true);
  let o = 16;
  for (let i = 0; i < lib.n; i++) {
    v.setFloat32(o, lib.lnSigma[i], true);
    v.setFloat32(o + 4, lib.momentum[i], true);
    v.setFloat32(o + 8, lib.wick[i], true);
    o += 12;
    for (let j = 0; j < lib.seconds; j++, o += 4) {
      v.setInt16(o, lib.close[i * lib.seconds + j], true);
      out[o + 2] = lib.up[i * lib.seconds + j];
      out[o + 3] = lib.down[i * lib.seconds + j];
    }
  }
  return out;
}

/**
 * How much each path counts: by how like now it started. Measured on paths
 * from days held back from the library: wider than this and a strong move
 * was priced like a quiet one; narrower and the far regions got noisy.
 */
export const KERNEL = { lnSigma: 0.4, momentum: 0.3 } as const;

/**
 * How much each path counts: by how like now it started. After a sharp
 * move there are few moments like it, and the chances measured on a
 * handful of paths come out in holes and blotches; so the match widens
 * until at least `MIN_PATHS` paths count. It widens on how busy the market
 * is, and hardly at all on which way it just moved: widened on momentum
 * as much, a bot drawing the way a jump went got back 1.23 per dollar,
 * because the jump was priced like a quiet moment.
 */
export const MIN_PATHS = 1500;
export function weightsFor(lib: Library, f: Features): { w: Float64Array; paths: number } {
  const w = new Float64Array(lib.n);
  const ls = Math.log(f.sigma);
  let paths = 0;
  for (let round = 0; round < 6; round++) {
    const busy = KERNEL.lnSigma * 1.5 ** round;
    const moved = KERNEL.momentum * (round >= 4 ? 1.25 : 1);
    let all = 0;
    let sq = 0;
    for (let i = 0; i < lib.n; i++) {
      const a = (lib.lnSigma[i] - ls) / busy;
      const b = (lib.momentum[i] - f.momentum) / moved;
      const wi = Math.exp(-0.5 * (a * a + b * b));
      w[i] = wi;
      all += wi;
      sq += wi * wi;
    }
    paths = sq > 0 ? (all * all) / sq : 0;
    if (paths >= MIN_PATHS) break;
  }
  return { w, paths };
}
const weights = (lib: Library, f: Features) => weightsFor(lib, f).w;

/* ------------------------------------------------------------------ */
/* The field: every dot's chance                                       */
/* ------------------------------------------------------------------ */

/** The price steps a dot can be, so the axis reads in round numbers. */
const NICE = [0.01, 0.02, 0.025, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100];

/** How tall a dot is for this market: `stepSigmas` one-second moves, to the nearest round step. */
export function stepFor(sigma: number, price: number): number {
  const want = RULES.stepSigmas * sigma * price;
  return NICE.reduce((best, s) => (Math.abs(Math.log(s / want)) < Math.abs(Math.log(best / want)) ? s : best), NICE[0]);
}

export const rowOf = (price: number, step: number) => Math.floor(price / step);

/**
 * Every dot's chance, for a drawing opening at `openAt`: seconds 1 to
 * `horizon` after it, rows `row0` to `row0 + rows - 1`. Each path is laid
 * over the field once, adding its weight to every dot its range covers in
 * each second.
 */
export type Field = { openAt: number; step: number; row0: number; rows: number; seconds: number; chance: Float32Array; rtp: number; f: Features; /** How many paths the chances rest on, as an effective count. */ paths: number };

export function field(lib: Library, f: Features, openAt: number, step: number): Field {
  const seconds = lib.seconds - 1;
  // Far enough to hold any move the paths make, and never more than 150 rows either way.
  const reach = Math.min(150, Math.ceil((8 * f.sigma * f.price * Math.sqrt(seconds)) / step));
  const here = rowOf(f.price, step);
  const row0 = here - reach;
  const rows = reach * 2 + 1;
  const acc = new Float64Array(seconds * rows);
  const w = weights(lib, f);
  let all = 0;
  let sq = 0;
  const k = f.sigma / LIB_SCALE;
  for (let i = 0; i < lib.n; i++) {
    const wi = w[i];
    if (wi < 1e-5) continue;
    all += wi;
    sq += wi * wi;
    // This path's swings, scaled to how far the market swings inside a second now.
    const swing = (Math.min(3, Math.max(0.33, f.wick / lib.wick[i])) * LIB_SCALE) / SWING_SCALE;
    const base = i * lib.seconds;
    let prev = lib.close[base];
    for (let j = 0; j < seconds; j++) {
      const c = lib.close[base + j + 1];
      const hi = rowOf(f.price * Math.exp((Math.max(prev, c) + lib.up[base + j + 1] * swing) * k), step) - row0;
      const lo = rowOf(f.price * Math.exp((Math.min(prev, c) - lib.down[base + j + 1] * swing) * k), step) - row0;
      prev = c;
      const a = Math.max(0, lo);
      const b = Math.min(rows - 1, hi);
      for (let r = a; r <= b; r++) acc[j * rows + r] += wi;
    }
  }
  /*
    A chance measured on `paths` paths is off by about sqrt(p(1-p)/paths),
    and paying 1/p on an estimate that is sometimes low pays more than the
    estimate is worth on average: on days the library had not seen, dots
    paid back 1.08 per dollar before this. Adding (1-p)/paths to each chance
    takes that back out, to first order. It raises rare dots most, which is
    where the estimate is thinnest.
  */
  const paths = sq > 0 ? (all * all) / sq : 0;
  const chance = new Float32Array(seconds * rows);
  if (all > 0 && paths > 0) for (let x = 0; x < acc.length; x++) {
    const p = acc[x] / all;
    chance[x] = p > 0 ? p + (1 - p) / paths : 0;
  }
  return { openAt, step, row0, rows, seconds, chance, rtp: rtpFor(f), f, paths };
}

/** A dot's chance on a field; zero off it. */
export function chanceOf(fl: Field, d: Dot): number {
  const j = Math.round((d.t - fl.openAt) / 1000);
  const r = d.row - fl.row0;
  if (j < 1 || j > fl.seconds || r < 0 || r >= fl.rows) return 0;
  return fl.chance[(j - 1) * fl.rows + r];
}

/**
 * What a dollar returns on average, for a spot at `price` on this market.
 * Less on the side the price has just moved towards, the harder it moved:
 * on days the paths had not seen, a move carried on further than the paths
 * said, and a bot drawing the way the last three seconds went got back
 * 1.04 per dollar, 1.12 just after a jump, when every spot was priced
 * alike. The other side is priced as usual.
 */
export function rtpAt(f: Features, price: number): number {
  const withIt = Math.sign(price - f.price) === Math.sign(f.momentum);
  return withIt ? RULES.rtp - RULES.momentumMargin * Math.min(2, Math.abs(f.momentum)) : RULES.rtp;
}
/** The return for a spot in no particular direction: the usual one. */
export const rtpFor = (_f: Features) => RULES.rtp;

/** What a chance pays: `rtp / chance`, to two figures and never rounded up. Null when it is not offered. */
export function multipleFor(p: number, rtp: number = RULES.rtp): number | null {
  if (!(p > 0)) return null;
  const fair = rtp / p;
  if (fair < RULES.minMultiple || fair > RULES.maxMultiple) return null;
  const unit = fair >= 10 ? 1 : fair >= 2 ? 0.1 : 0.01;
  return Math.round(Math.floor(fair / unit + 1e-9) * unit * 100) / 100;
}

export const multipleOf = (fl: Field, d: Dot) => multipleFor(chanceOf(fl, d), rtpAt(fl.f, (d.row + 0.5) * fl.step));

/* ------------------------------------------------------------------ */
/* A drawing's life                                                    */
/* ------------------------------------------------------------------ */

/** The second a drawing placed at `now` opens on. */
export const openFor = (now: number) => Math.floor(now / 1000) * 1000 + 1000;

/** Whether a dot can be in a drawing opening at `openAt`: from the second after it, up to the horizon. */
export const inReach = (d: Dot, openAt: number) => d.t >= openAt + 1000 && d.t <= openAt + RULES.horizon * 1000;

/** Painted dots, as a drawing: not priced yet. Its cost is every painted dot; what is not on offer when it opens comes back. */
export function place(painted: Dot[], perDot: number, step: number, now: number, id: string, stroke?: Stroke): Bet | null {
  const openAt = openFor(now);
  const seen = new Set<string>();
  const dots = painted.filter((d) => {
    const k = `${d.t}:${d.row}`;
    if (seen.has(k) || !inReach(d, openAt)) return false;
    seen.add(k);
    return true;
  });
  if (!dots.length) return null;
  return { id, placedAt: now, openAt, perDot, step, painted: dots.slice(0, RULES.maxDots), dots: [], status: "opening", stroke };
}

export const cost = (bet: Bet) => bet.perDot * bet.painted.length;
/** What comes back when it opens: the dots no longer on offer, or all of them when it is voided. */
export const refund = (bet: Bet) => (bet.status === "void" ? cost(bet) : bet.status === "opening" ? 0 : bet.perDot * (bet.painted.length - bet.dots.length));
export const won = (bet: Bet) => bet.dots.reduce((s, d) => s + (d.paid ?? 0), 0);
export const hits = (bet: Bet) => bet.dots.filter((d) => d.status === "hit").length;
/** Nothing left to happen: every dot decided, or voided when it opened. */
export const decided = (bet: Bet) => bet.status === "done" || bet.status === "void";

/**
 * Price a drawing on the second it opened, from the bars before it. A dot
 * the market has moved onto, or too far from, is dropped and its cost comes
 * back; if none is left the drawing is voided. `ready` is a field measured
 * for the same second on the same bars, if there is one.
 */
export function open(bet: Bet, lib: Library, bars: Bar[], ready?: Field): Bet {
  const f = features(bars, bet.openAt);
  if (!f) return { ...bet, status: "void", why: "No price to open on." };
  // A field already measured for this second and this market is the same field.
  const same = ready && ready.openAt === bet.openAt && ready.step === bet.step && ready.f.price === f.price && ready.f.sigma === f.sigma && ready.f.momentum === f.momentum && ready.f.wick === f.wick;
  const fl = same ? ready : field(lib, f, bet.openAt, bet.step);
  const dots: BetDot[] = [];
  for (const d of bet.painted) {
    const m = multipleOf(fl, d);
    if (m !== null) dots.push({ ...d, multiple: m, status: "live" });
  }
  if (!dots.length) return { ...bet, status: "void", why: "The price moved, and none of it is on offer now." };
  return { ...bet, status: "live", dots };
}

/**
 * Judge a live drawing on one second's bar, as it stands: a dot in that
 * second is hit the moment the bar's range reaches its step. Once the bar's
 * second is over (`closed`, after a margin for trades that arrive late), its
 * dots that were not hit, and any before it, are missed.
 */
export function judge(bet: Bet, bar: Bar, closed: boolean): Bet {
  if (bet.status !== "live") return bet;
  let changed = false;
  const dots = bet.dots.map((d) => {
    if (d.status !== "live") return d;
    // The same rule the chances were counted with: the rows from the bar's low to its high, each row from its bottom edge up to, not including, its top.
    if (d.t === bar.t && rowOf(bar.l, bet.step) <= d.row && d.row <= rowOf(bar.h, bet.step)) {
      {
        changed = true;
        return { ...d, status: "hit" as const, paid: Math.floor(bet.perDot * d.multiple * 100) / 100 };
      }
    }
    if (closed && d.t <= bar.t) {
      changed = true;
      return { ...d, status: "miss" as const };
    }
    return d;
  });
  if (!changed) return bet;
  return { ...bet, dots, status: dots.every((d) => d.status !== "live") ? "done" : "live" };
}
