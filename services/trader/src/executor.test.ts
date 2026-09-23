import { expect, test } from "bun:test";
import { Accounts, Executor, type Position, type VenueFill } from "./executor";
import type { Lighter, MarketInfo } from "./lighter";
import type { Signer } from "./signer";
import type { VenueSocket } from "./venue-socket";

const btc: MarketInfo = { id: 1, symbol: "BTC", sizeDecimals: 5, priceDecimals: 1, minBase: 0.00007, minQuote: 10, last: 86000 };
const eth: MarketInfo = { id: 0, symbol: "ETH", sizeDecimals: 4, priceDecimals: 2, minBase: 0.002, minQuote: 10, last: 2700 };

/** A socket that only records subscriptions, so pushes can be played into them. */
function fakeSocket() {
  const handlers = new Map<string, (m: Record<string, unknown>) => void>();
  const socket = { subscribe: (channel: string, fn: (m: Record<string, unknown>) => void) => (handlers.set(channel, fn), () => handlers.delete(channel)) };
  return { socket: socket as unknown as VenueSocket, push: (channel: string, m: Record<string, unknown>) => handlers.get(channel)?.(m) };
}

test("one account's pushes reach the market they are about, and a market it does not list is flat", () => {
  const { socket, push } = fakeSocket();
  const account = new Executor({ socket, http: {} as Lighter, signer: {} as Signer, accountIndex: 7, apiKeyIndex: 3 });
  account.start();
  const onBtc = account.on(() => btc, () => null);
  const onEth = account.on(() => eth, () => null);
  expect(account.on(() => btc, () => null)).toBe(onBtc);
  expect(onEth.position()).toBeNull();

  const seen: { btc: Position[]; eth: Position[]; ethFills: VenueFill[] } = { btc: [], eth: [], ethFills: [] };
  onBtc.onPosition((p) => seen.btc.push(p));
  onEth.onPosition((p) => seen.eth.push(p));
  onEth.onFill((f) => seen.ethFills.push(f));

  push("account_all_positions/7", { positions: { "0": { position: "0.0370", sign: -1, avg_entry_price: "2700", unrealized_pnl: "0.5" } } });
  expect(onEth.position()!.size).toBeCloseTo(-0.037);
  expect(onBtc.position()!.size).toBe(0);
  expect(seen.eth).toHaveLength(1);
  expect(seen.btc).toHaveLength(1);

  push("account_all_trades/7", { trades: { "0": [{ trade_id: 1, price: "2700", size: "0.037" }], "1": [{ trade_id: 2, price: "86000", size: "0.001" }] } });
  expect(seen.ethFills.map((f) => f.trade_id)).toEqual([1]);
});

test("a wallet's executor is opened once however many requests arrive while it opens", async () => {
  let opens = 0;
  let key = true;
  const stopped: number[] = [];
  const pool = new Accounts(async () => {
    opens++;
    await Bun.sleep(5);
    if (!key) return null;
    const n = opens;
    return { n, stop: () => stopped.push(n) };
  });
  const [a, b] = await Promise.all([pool.get("0xAB"), pool.get("0xab")]);
  expect(opens).toBe(1);
  expect(a).toBe(b);
  expect(await pool.get("0xab")).toBe(a);

  // A new key replaces it: the old one is stopped and the next request opens afresh.
  pool.forget("0xAb");
  const c = await pool.get("0xab");
  expect(stopped).toEqual([1]);
  expect(c).not.toBe(a);

  // No key is not remembered, so registering one later is picked up.
  key = false;
  pool.forget("0xab");
  expect(await pool.get("0xab")).toBeNull();
  key = true;
  expect(await pool.get("0xab")).not.toBeNull();
  expect(opens).toBe(4);
});

test("a signer that fails to open is not remembered", async () => {
  let fail = true;
  const pool = new Accounts(async () => {
    if (fail) throw Error("bad key");
    return { stop() {} };
  });
  await expect(pool.get("0xab")).rejects.toThrow("bad key");
  fail = false;
  expect(await pool.get("0xab")).not.toBeNull();
});
