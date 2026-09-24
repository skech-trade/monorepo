import type { Candle } from "./market";
import type { VenueOrder, VenueTrade } from "./round";

/**
 * What each trade made against the chart.
 *
 * Testnet's book is a quote that does not move: its mark sat at the same
 * dollar for twenty seconds while mainnet, which is what the chart shows,
 * moved the whole time. So on testnet the venue's P&L is the spread and
 * nothing else, whichever way a trade faced. This values each real trade, at
 * its real size and its real fill times, at the chart's price instead, which
 * is the number that says whether the line was right. It is labelled as the
 * chart's everywhere it appears; the venue's figure is shown beside it.
 *
 * Each order's price is the one the trader stamped when the venue took it,
 * the chart's live mid at that moment, which is also what the round's stop
 * is judged on. Reading it off the candles instead put the page and the
 * stop up to a dollar apart. Rounds from before the stamp fall back to them.
 */

export type ChartTrade = { id: string; dir: 1 | -1; from: number; to: number | null; entry: number; exit: number; pnl: number };
export type ChartPnl = { net: number; trades: ChartTrade[] };

/** The chart's price at a moment, read along the candle it falls in. */
export function chartPriceAt(candles: Candle[], at: number, bucketMs = 500): number | null {
  if (!candles.length) return null;
  if (at < candles[0].t) return candles[0].o;
  let lo = 0;
  let hi = candles.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (candles[mid].t <= at) lo = mid;
    else hi = mid - 1;
  }
  const c = candles[lo];
  const k = Math.min(1, Math.max(0, (at - c.t) / bucketMs));
  return c.o + (c.c - c.o) * k;
}

/**
 * When a trade's open or close happened. The venue's acceptance, not the fill
 * push: the push trails execution by a few hundred milliseconds, and testnet's
 * own fill timestamps were seen up to seventeen seconds before the order was
 * even sent, so they cannot be used at all.
 */
const whenOf = (o: VenueOrder | undefined) => o?.ackAt ?? o?.filledAt ?? o?.sentAt ?? null;

export function chartPnl(trades: VenueTrade[], orders: VenueOrder[], candles: Candle[], livePrice: number | null): ChartPnl {
  const out: ChartTrade[] = [];
  for (const t of trades) {
    if (t.status === "failed") continue;
    const open = orders.find((o) => o.tradeId === t.id && o.kind === "open" && o.status !== "rejected");
    const close = orders.find((o) => o.tradeId === t.id && o.kind === "close" && o.status !== "rejected");
    const from = whenOf(open);
    if (from === null) continue;
    // The trader's own stamp when it has one, so the page, the result and the stop agree on the price.
    const entry = open?.chartAt ?? chartPriceAt(candles, from);
    if (entry === null) continue;
    const to = whenOf(close);
    const exit = to !== null ? (close?.chartAt ?? chartPriceAt(candles, to)) : livePrice;
    if (exit === null) continue;
    const size = open?.filled || t.size;
    out.push({ id: t.id, dir: t.dir, from, to, entry, exit, pnl: t.dir * (exit - entry) * size });
  }
  return { net: out.reduce((sum, t) => sum + t.pnl, 0), trades: out };
}
