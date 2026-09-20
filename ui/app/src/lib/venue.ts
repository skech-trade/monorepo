/**
 * Lighter, as the venue actually is.
 *
 * Every number here was read off the live API on 2026-09-20 from
 * `GET /api/v1/orderBookDetails` and `apidocs.lighter.xyz`, not from a
 * spec. One file, because four different liquidation formulas were live at
 * once and every screen told a different story about where you get wiped out.
 */

/** BTC on Lighter. The only market skech lists. */
export const MARKET = {
  /** `market_index` in every order. */
  id: 1,
  symbol: "BTC",
  /** Sizes round down to this many decimals of BTC. */
  sizeDecimals: 5,
  /** Prices are sent as USD times ten, so a tenth of a dollar. */
  priceDecimals: 1,
  /** Smaller than either and the venue rejects the order. */
  minBase: 0.00007,
  minQuote: 10,
  maxLeverage: 50,
} as const;

/**
 * Standard accounts pay nothing, either side.
 *
 * Which is the whole argument for routing here: at fifty times a hundred
 * dollars a Hyperliquid round trip is $4.50, and a leg would have to travel
 * $57.60 to break even on a market that moves six dollars a second.
 */
export const FEE = { maker: 0, taker: 0 } as const;

/**
 * Where the venue steps in, as fractions rather than the basis points the API
 * reports. Maintenance is the level the position is closed at; close-out is
 * what is left when it is.
 */
export const MARGIN = {
  maintenance: 0.012,
  closeout: 0.008,
  /** Default initial margin. Above 20x an account needs `update_leverage`. */
  initial: 0.05,
} as const;

/**
 * How long between asking for a fill and getting one, as a share of a candle.
 *
 * Lighter delays taker orders 300ms on Standard by design; call it 500ms with
 * our own hop. A candle here is a second, so half of one.
 */
export const LATENCY_BARS = 0.5;

/** A size the venue will accept: rounded down to its step. */
export const roundSize = (btc: number) => Math.floor(btc * 10 ** MARKET.sizeDecimals) / 10 ** MARKET.sizeDecimals;

/** A price the venue will accept: rounded to its tick. */
export const roundPrice = (usd: number) => Math.round(usd * 10 ** MARKET.priceDecimals) / 10 ** MARKET.priceDecimals;

/** Whether the venue would take this order at all. */
export const tradeable = (btc: number, price: number) => roundSize(btc) >= MARKET.minBase && roundSize(btc) * price >= MARKET.minQuote;

/**
 * Where isolated margin gives out, solved the way a venue does it.
 *
 * Equity is the stake less the fee paid getting in, plus what the position has
 * made. The venue closes when that falls to `maintenance` of the position's
 * value at the mark. Solving the two for price:
 *
 *   long   P = (q·entry − room) / (q · (1 − mmr))
 *   short  P = (q·entry + room) / (q · (1 + mmr))
 *
 * The three formulas this replaces were all `entry × (1 ∓ 0.9/leverage)`,
 * which treats maintenance as a flat haircut on entry rather than a claim
 * against the mark. It lands close at fifty times and drifts badly below ten.
 */
export function liquidationPrice(entry: number, stake: number, leverage: number, dir: 1 | -1): number {
  const q = (stake * leverage) / entry;
  const room = stake - FEE.taker * stake * leverage;
  return dir > 0 ? (q * entry - room) / (q * (1 - MARGIN.maintenance)) : (q * entry + room) / (q * (1 + MARGIN.maintenance));
}
