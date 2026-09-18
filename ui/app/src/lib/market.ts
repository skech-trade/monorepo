export type Candle = {
  /** Unix ms of the bar's open. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** Base-currency volume traded in the bar. */
  v: number;
};

export type Market = {
  /** The address in the URL, checksummed as given. */
  address: string;
  symbol: string;
  name: string;
  price: number;
  /** Absolute move over the last 24h, in quote currency. */
  change: number;
  changePct: number;
  high24h: number;
  low24h: number;
  /** Quote-currency volume over the last 24h. */
  volume24h: number;
  /** Open interest, quote currency. */
  openInterest: number;
  /** Per-hour funding rate as a fraction, positive means longs pay. */
  funding: number;
};

export type Position = {
  id: string;
  symbol: string;
  side: "long" | "short";
  /** Position size in quote currency. */
  notional: number;
  leverage: number;
  entry: number;
  liquidation: number;
  pnl: number;
  pnlPct: number;
};

export const TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h", "1D", "1W"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

/** Bar length in ms, used to lay the series out along a real time axis. */
const SPAN: Record<Timeframe, number> = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1D": 86_400_000,
  "1W": 604_800_000,
};

// --- seeds -----------------------------------------------------------------

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a over the lowercased string. Stable across runtimes. */
function hash(s: string) {
  let h = 0x811c9dc5;
  const lower = s.toLowerCase();
  for (let i = 0; i < lower.length; i++) {
    h ^= lower.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// --- the market ------------------------------------------------------------

/**
 * Bitcoin, and nothing else.
 *
 * One market at launch. The address is WBTC's on mainnet, because the route is
 * an address and that is the one people paste; the market is named BTC because
 * that is what the price is of.
 *
 * Adding a second market is a row in `KNOWN` plus its address in `LISTED` —
 * the screen already takes the market as a prop and formats to whatever
 * precision the price needs. Nothing below this line knows there is only one.
 */
const KNOWN: Record<string, { symbol: string; name: string; price: number }> = {
  "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599": {
    symbol: "BTC",
    name: "Bitcoin",
    price: 64_180,
  },
};

/**
 * The markets, in listing order.
 *
 * Checksummed, because that is the form a reader copies out of a block
 * explorer and the form that should appear in the URL bar. `KNOWN` is keyed
 * lowercase, so either spelling resolves.
 */
export const LISTED = ["0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599"];

/** The one market, for the redirects that have to name it. */
export const DEFAULT_MARKET = LISTED[0];

/**
 * `null` for an address that is not listed.
 *
 * Deliberately not a generated placeholder. An unknown address is either a
 * typo or a market we do not run, and inventing a ticker and a price for it
 * would make both look like a market we do.
 */
export function marketFor(address: string): Market | null {
  const base = KNOWN[address.toLowerCase()];
  if (!base) return null;

  const rand = mulberry32(hash(address) ^ 0x9e3779b9);

  const changePct = (rand() - 0.42) * 9.4;
  const change = (base.price * changePct) / 100;
  const prev = base.price - change;

  return {
    address,
    symbol: base.symbol,
    name: base.name,
    price: base.price,
    change,
    changePct,
    high24h: Math.max(base.price, prev) * (1 + rand() * 0.018),
    low24h: Math.min(base.price, prev) * (1 - rand() * 0.018),
    volume24h: base.price * (1_400 + rand() * 42_000) * 120,
    openInterest: base.price * (900 + rand() * 12_000) * 40,
    funding: (rand() - 0.5) * 0.00018,
  };
}

// --- the series ------------------------------------------------------------

/**
 * `count` bars walking into the market's current price.
 *
 * Built backwards from the close so the last candle lands exactly on the price
 * in the header. A series generated forwards drifts, and then the chart's last
 * bar and the header disagree by a few percent, which is the single fastest
 * way to make a trading screen look fake.
 */
export function candlesFor(
  market: Market,
  timeframe: Timeframe,
  count = 400,
): Candle[] {
  const rand = mulberry32(hash(market.address + timeframe));
  const span = SPAN[timeframe];

  // Longer bars carry more of a move. Roughly the square root of the span, in
  // units of the 1m bar, which is how volatility actually scales with horizon.
  const vol = 0.0016 * Math.sqrt(span / SPAN["1m"]);

  // Bars are laid out on a whole-bar grid ending at the most recent open, so
  // two timeframes of the same market line up rather than each starting at an
  // arbitrary offset.
  const now = Math.floor(Date.now() / span) * span;

  const closes: number[] = [market.price];
  for (let i = 0; i < count; i++) {
    const prev = closes[0] / (1 + (rand() - 0.5) * 2 * vol);
    closes.unshift(prev);
  }

  const out: Candle[] = [];
  for (let i = 0; i < count; i++) {
    const o = closes[i];
    const c = closes[i + 1];
    const wick = (Math.max(o, c) - Math.min(o, c)) * (0.4 + rand() * 1.8) + o * vol * 0.35;
    // Volume tracks the size of the move, the way it does in a real tape: a
    // flat bar on heavy volume is a thing that happens, a 3% bar on nothing is
    // not, and a histogram uncorrelated with the candles above it reads as
    // noise drawn under the chart.
    const move = Math.abs(c - o) / o;
    out.push({
      t: now - (count - 1 - i) * span,
      o,
      c,
      h: Math.max(o, c) + rand() * wick,
      l: Math.min(o, c) - rand() * wick,
      v: (0.6 + rand() * 0.9 + move / vol / 6) * (span / SPAN["1m"]) * 7.4,
    });
  }
  return out;
}

// --- open positions --------------------------------------------------------

/**
 * Two open positions, so the table is reviewable as a table rather than only
 * as an empty state. An address that hashes even gets one position instead of
 * two, and one in four gets none, which is enough variety to see all three.
 */
export function positionsFor(market: Market): Position[] {
  const rand = mulberry32(hash(market.address) ^ 0x2545f491);
  const n = [2, 1, 2, 0][Math.floor(rand() * 4)];

  return Array.from({ length: n }, (_, i) => {
    const side: "long" | "short" = rand() > 0.42 ? "long" : "short";
    const leverage = [2, 3, 5, 10, 20][Math.floor(rand() * 5)];
    const notional = Math.round((240 + rand() * 4_800) / 10) * 10;
    const entry = market.price * (1 + (rand() - 0.5) * 0.06);
    const move = (market.price - entry) / entry;
    const pnlPct = (side === "long" ? move : -move) * leverage * 100;

    return {
      id: `${market.address.slice(2, 8)}-${i}`,
      symbol: market.symbol,
      side,
      notional,
      leverage,
      entry,
      liquidation:
        side === "long"
          ? entry * (1 - 0.9 / leverage)
          : entry * (1 + 0.9 / leverage),
      pnl: (notional * pnlPct) / 100,
      pnlPct,
    };
  });
}

// --- formatting ------------------------------------------------------------

/**
 * How many decimals a price of this size deserves.
 *
 * One rule, applied everywhere, so the entry in the ticket, the axis on the
 * chart and the entry in the positions table all round the same way. Two
 * places for anything over a dollar; more as the number gets small, because
 * $0.0004 and $0.0009 are a factor of two apart and "$0.00" twice is not a
 * price.
 */
export function priceDp(price: number): number {
  // Zero carries no precision, and asking it for seven decimal places is how
  // an axis ends up labelled "0.000000".
  if (!Number.isFinite(price) || price === 0) return 2;
  if (price >= 100) return 2;
  if (price >= 1) return 3;
  if (price >= 0.01) return 5;
  return 7;
}

export function usd(n: number, dp = 2): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  });
}

/** A price, formatted at its own precision. */
export function price(n: number): string {
  return usd(n, priceDp(n));
}

/** Money with its sign, and a plain "$0.00" when there is nothing in it. */
export function signedUsd(n: number, dp = 2): string {
  if (Math.abs(n) < 10 ** -dp / 2) return `$${usd(0, dp)}`;
  return `${n > 0 ? "+" : "−"}$${usd(Math.abs(n), dp)}`;
}

export function signedPct(n: number, dp = 2): string {
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${usd(Math.abs(n), dp)}%`;
}

/** Large figures in the header, where four digits of volume is noise. */
export function compactUsd(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${usd(n / 1e9, 2)}B`;
  if (abs >= 1e6) return `$${usd(n / 1e6, 2)}M`;
  if (abs >= 1e3) return `$${usd(n / 1e3, 1)}K`;
  return `$${usd(n, 2)}`;
}

/** `0x1234…cdef`. Long enough to compare two by eye, short enough for a chip. */
export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * The wallet's collateral balance. Mock, like everything else here — it exists
 * so the percentage chips in the ticket have something to be a percentage of.
 */
export const BALANCE = 12_480.55;

// --- the book, the tape, the account -----------------------------------------

export type BookLevel = {
  price: number;
  /** Size at this price, base currency. */
  size: number;
  /** Everything resting at this price or better, for the depth bar. */
  total: number;
};

export type Trade = {
  id: string;
  price: number;
  size: number;
  side: "buy" | "sell";
  /** Unix ms. */
  t: number;
};

export type RestingOrder = {
  id: string;
  symbol: string;
  side: "long" | "short";
  type: "limit" | "stop";
  price: number;
  size: number;
  /** Fraction of the order already filled, 0 to 1. */
  filled: number;
  t: number;
};

export type Fill = {
  id: string;
  symbol: string;
  side: "long" | "short";
  price: number;
  size: number;
  fee: number;
  t: number;
};

export type Account = {
  /** Collateral plus unrealised P&L. */
  equity: number;
  balance: number;
  /** Collateral committed to open positions. */
  used: number;
  free: number;
  unrealised: number;
  /** Equity over used margin. Below ~1.1 is where liquidation lives. */
  health: number;
};

/**
 * A resting book around the mark.
 *
 * The shape matters more than the numbers: size thins out as you walk away
 * from the touch, with the occasional wall, because a book with uniform size at
 * every level reads as a table rather than as a market. The spread is one tick
 * and the two sides are generated from the same seed so they stay plausible
 * against each other.
 */
export function bookFor(market: Market, depth = 12): {
  bids: BookLevel[];
  asks: BookLevel[];
  spread: number;
} {
  const rand = mulberry32(hash(market.address) ^ 0x85ebca6b);
  const tick = 10 ** -priceDp(market.price) * (market.price > 1000 ? 100 : 1);

  const side = (direction: 1 | -1): BookLevel[] => {
    const out: BookLevel[] = [];
    let total = 0;
    for (let i = 0; i < depth; i++) {
      // Thins with distance, with a fat level every so often.
      const wall = rand() > 0.86 ? 4.5 : 1;
      const size = (0.35 + rand() * 1.5) * wall * (1 - i / (depth * 1.7));
      total += size;
      out.push({
        price: market.price + direction * tick * (i + 1),
        size,
        total,
      });
    }
    return out;
  };

  return { asks: side(1), bids: side(-1), spread: tick * 2 };
}

/**
 * The tape: recent prints, newest first.
 *
 * Two things that were wrong when this was a bag of random numbers, and both
 * were visible at a glance:
 *
 *   The times were not in order. The gap between prints was randomised *per
 *   print* and then multiplied by the index, so a later row could carry an
 *   earlier clock. Gaps accumulate now, which is what a tape is.
 *
 *   The colour did not agree with the price. On a real tape the colour is the
 *   aggressor — a buy lifted the offer, a sell hit the bid — so buys print at
 *   or above the mid and sells at or below it. Assigning the side by coin flip
 *   and the price by a separate coin flip produced a green print below a red
 *   one at a lower price, which reads as broken to anyone who has watched one.
 */
export function tradesFor(market: Market, count = 28): Trade[] {
  const rand = mulberry32(hash(market.address) ^ 0xc2b2ae35);
  const tick = 10 ** -priceDp(market.price) * (market.price > 1000 ? 100 : 1);

  const out: Trade[] = [];
  let t = Date.now();
  let mid = market.price;

  for (let i = 0; i < count; i++) {
    const buy = rand() > 0.5;
    // Size is heavily skewed: most prints are dust, a few are real.
    const size = 0.002 + rand() ** 3.2 * 1.4;

    out.push({
      id: `${market.address.slice(2, 6)}-t${i}`,
      // Buys take the offer, sells hit the bid. One tick of spread either way.
      price: mid + (buy ? tick : -tick) * (0.5 + rand() * 0.5),
      side: buy ? "buy" : "sell",
      size,
      t,
    });

    // Walking backwards through time, so the gap comes off the clock and the
    // mid drifts against the direction of the print that moved it.
    t -= 700 + rand() * 4_800;
    mid -= (buy ? 1 : -1) * tick * rand() * 0.8;
  }
  return out;
}

/** Two resting orders, so the orders tab is reviewable as a list. */
export function ordersFor(market: Market): RestingOrder[] {
  const rand = mulberry32(hash(market.address) ^ 0x27d4eb2f);
  const now = Date.now();
  return Array.from({ length: 2 }, (_, i) => {
    const side: "long" | "short" = rand() > 0.5 ? "long" : "short";
    return {
      id: `${market.address.slice(2, 6)}-o${i}`,
      symbol: market.symbol,
      side,
      type: rand() > 0.65 ? ("stop" as const) : ("limit" as const),
      price: market.price * (1 + (rand() - 0.5) * 0.08),
      size: Math.round((180 + rand() * 2_400) / 10) * 10,
      filled: rand() > 0.7 ? rand() * 0.6 : 0,
      t: now - (i + 1) * 1_800_000,
    };
  });
}

/** Filled trades, newest first. */
export function fillsFor(market: Market, count = 6): Fill[] {
  const rand = mulberry32(hash(market.address) ^ 0x165667b1);
  const now = Date.now();
  return Array.from({ length: count }, (_, i) => {
    const size = Math.round((120 + rand() * 3_100) / 10) * 10;
    return {
      id: `${market.address.slice(2, 6)}-f${i}`,
      symbol: market.symbol,
      side: rand() > 0.5 ? ("long" as const) : ("short" as const),
      price: market.price * (1 + (rand() - 0.5) * 0.05),
      size,
      fee: size * 0.0005,
      t: now - (i + 1) * (3_600_000 + rand() * 9_000_000),
    };
  });
}

/** Margin and equity, derived from the open positions so the two agree. */
export function accountFor(positions: Position[]): Account {
  const unrealised = positions.reduce((sum, p) => sum + p.pnl, 0);
  const used = positions.reduce((sum, p) => sum + p.notional / p.leverage, 0);
  const equity = BALANCE + unrealised;
  return {
    equity,
    balance: BALANCE,
    used,
    free: Math.max(0, equity - used),
    unrealised,
    health: used > 0 ? equity / used : Number.POSITIVE_INFINITY,
  };
}
