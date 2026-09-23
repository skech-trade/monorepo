/**
 * The markets the feed charts, by symbol, in mainnet's numbering: the chart is
 * always mainnet, whichever network the wallet trades on.
 *
 * The same ids as `VENUE_MARKETS.mainnet` in `@skech/core`. Copied rather than
 * imported because this service builds on its own (compose's context for it
 * is `services/feed`, with no workspace to resolve the package from). A market
 * added there has to be added here too.
 */
export const MARKETS = { BTC: 1, ETH: 0 } as const;

export type Symbol = keyof typeof MARKETS;

export const SYMBOLS = Object.keys(MARKETS) as Symbol[];

/**
 * The market a request asks for with `?market=`. Absent is Bitcoin, which is
 * what every browser asked for before there was a choice; anything unlisted is
 * null. An own key, not `in`: `in` walks the prototype, so `?market=toString`
 * passed and then had no feed behind it.
 */
export const marketOf = (v: string | null): Symbol | null =>
  v === null ? "BTC" : Object.hasOwn(MARKETS, v) ? (v as Symbol) : null;

/** One of something per market, so adding a market is a line in `MARKETS`. */
export const perMarket = <T>(make: (market: Symbol) => T) =>
  Object.fromEntries(SYMBOLS.map((m) => [m, make(m)])) as Record<Symbol, T>;
