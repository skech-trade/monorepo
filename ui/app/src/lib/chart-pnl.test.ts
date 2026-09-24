import { expect, test } from "bun:test";
import { chartPnl, chartPriceAt } from "./chart-pnl";
import type { Candle } from "./market";
import type { VenueOrder, VenueTrade } from "./round";

/** A market rising a dollar every half second from 100. */
const candles: Candle[] = Array.from({ length: 40 }, (_, i) => ({ t: 1000 + i * 500, o: 100 + i, h: 101 + i, l: 100 + i, c: 101 + i, v: 1 }));
const order = (tradeId: string, kind: "open" | "close", ackAt: number): VenueOrder => ({ id: `${tradeId}-${kind}`, tradeId, kind, side: "buy", size: 2, dueAt: 0, requestedAt: 0, filled: 2, pnl: 0, status: "filled", ackAt, filledAt: ackAt + 300 });

test("the chart's price is read along the candle a moment falls in", () => {
  expect(chartPriceAt(candles, 1000)).toBe(100);
  expect(chartPriceAt(candles, 1250)).toBe(100.5);
  expect(chartPriceAt(candles, 0)).toBe(100);
});

test("a long in a rising chart makes money, a short loses the same", () => {
  const trades: VenueTrade[] = [{ id: "a", dir: 1, size: 2, status: "closed", pnl: -4 }, { id: "b", dir: -1, size: 2, status: "closed", pnl: -4 }];
  const orders = [order("a", "open", 1000), order("a", "close", 3000), order("b", "open", 3000), order("b", "close", 5000)];
  const r = chartPnl(trades, orders, candles, null);
  expect(r.trades.map((t) => t.pnl)).toEqual([8, -8]);
  expect(r.net).toBe(0);
});

test("an open trade is marked at the live price", () => {
  const trades: VenueTrade[] = [{ id: "a", dir: 1, size: 2, status: "open", pnl: 0 }];
  const r = chartPnl(trades, [order("a", "open", 1000)], candles, 110);
  expect(r.net).toBe(20);
  expect(r.trades[0].to).toBeNull();
});

test("a trade that never filled is not counted", () => {
  const trades: VenueTrade[] = [{ id: "a", dir: 1, size: 2, status: "failed", pnl: 0 }];
  expect(chartPnl(trades, [], candles, 110).net).toBe(0);
});

test("the trader's stamp is the price, so the page and the stop agree; candles only fill in for old rounds", () => {
  const trades: VenueTrade[] = [{ id: "a", dir: 1, size: 2, status: "closed", pnl: -4 }];
  const stamped = [{ ...order("a", "open", 1000), chartAt: 100.2 }, { ...order("a", "close", 3000), chartAt: 103.7 }];
  expect(chartPnl(trades, stamped, candles, null).net).toBeCloseTo(7);
  // No stamps: read off the candles, as before.
  expect(chartPnl(trades, [order("a", "open", 1000), order("a", "close", 3000)], candles, null).net).toBe(8);
});
