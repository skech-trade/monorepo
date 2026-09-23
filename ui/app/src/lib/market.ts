import type { Symbol as VenueSymbol } from "./venue";

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

// --- the market ------------------------------------------------------------

/**
 * The markets: WBTC's and WETH's mainnet addresses, named for what Lighter trades. Another market
 * is a row in `KNOWN`, its address in `LISTED`, and its symbol in `@skech/core/venue`.
 */
const KNOWN: Record<string, { symbol: VenueSymbol; name: string }> = {
  "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599": { symbol: "BTC", name: "Bitcoin" },
  "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": { symbol: "ETH", name: "Ethereum" },
};

/**
 * Listing order, checksummed as a block explorer prints it; `KNOWN` is keyed lowercase so either
 * spelling resolves.
 */
export const LISTED = ["0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"];

/** Bitcoin, for the redirects that have to name a market. */
export const DEFAULT_MARKET = LISTED[0];

/** A listed market by its symbol, for pointing at a round that runs on another one. */
export function marketBySymbol(symbol: string): Market | null {
  const address = LISTED.find((a) => KNOWN[a.toLowerCase()]?.symbol === symbol);
  return address ? marketFor(address) : null;
}

/**
 * Null, never a placeholder: an unknown address must not look like a market we run. The figures
 * start at zero and the live feed fills them in.
 */
export function marketFor(address: string): Market | null {
  const base = KNOWN[address.toLowerCase()];
  if (!base) return null;
  return {
    address,
    symbol: base.symbol,
    name: base.name,
    price: 0,
    change: 0,
    changePct: 0,
    high24h: 0,
    low24h: 0,
    volume24h: 0,
    openInterest: 0,
    funding: 0,
  };
}

// --- formatting ------------------------------------------------------------

/** One rounding rule everywhere: two places over a dollar, more as the price gets small. */
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

/** `0x1234…cdef`. Long enough to compare two by eye, short enough for a chip. */
export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
