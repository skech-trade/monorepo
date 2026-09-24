import { afterAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { micro, settle } from "./money";
import { BoostStore, userAccount } from "./store";

/**
 * The books against a real Postgres. Each run books under its own network
 * name, so it never sees another run's rows, or the app's.
 * Skipped without DATABASE_URL.
 */

const url = process.env.DATABASE_URL ?? "";
const run = url ? test : test.skip;
const networks: string[] = [];
/** Round ids are unique across networks, so each run's are its own. */
const RUN = crypto.randomUUID().slice(0, 8);
const id = (name: string) => `${RUN}-${name}`;
afterAll(async () => {
  if (!url) return;
  const sql = new SQL(url);
  for (const n of networks) {
    await sql`DELETE FROM boost_ledger WHERE network = ${n}`;
    await sql`DELETE FROM boost_rounds WHERE network = ${n}`;
    await sql`DELETE FROM boost_lanes WHERE network = ${n}`;
  }
  await sql.close();
});
const fresh = async () => {
  const network = `test-${crypto.randomUUID().slice(0, 8)}`;
  networks.push(network);
  const store = new BoostStore(network, url);
  await store.ready();
  await store.syncLanes([101, 102]);
  // Each lane topped up to its float, the way the desk tends them.
  await store.release(101, micro(200));
  await store.release(102, micro(200));
  await store.seed(micro(1000));
  return store;
};
const alice = "0x00000000000000000000000000000000000a11ce";
const bob = "0x0000000000000000000000000000000000000b0b";

run("a round holds stake and boost, then books exactly what the lane held", async () => {
  const s = await fresh();
  await s.credit(alice, micro(30), "dep:1");
  await s.credit(alice, micro(30), "dep:1"); // the same deposit twice books once
  expect(await s.balance(userAccount(alice))).toBe(micro(30));
  const { lane, before } = await s.reserve({ id: id("r1"), address: alice, accountIndex: 5, market: "BTC", stake: micro(10), boost: micro(50), cap: micro(500) });
  expect([101, 102]).toContain(lane);
  expect(before).toBe(micro(200));
  expect((await s.get(id("r1")))?.laneBefore).toBe(micro(200));
  expect(await s.balance(userAccount(alice))).toBe(micro(20));
  expect(await s.balance("treasury")).toBe(micro(950));
  expect(await s.outstanding()).toBe(micro(50));
  const result = settle(micro(10), micro(50), micro(63), 0.3, 0.01);
  await s.book(id("r1"), result);
  await s.book(id("r1"), result); // retried after a crash: nothing twice
  expect(await s.balance(userAccount(alice))).toBe(micro(32.1));
  expect(await s.balance("fees")).toBe(micro(0.9));
  expect(await s.balance("treasury")).toBe(micro(1000));
  expect(await s.outstanding()).toBe(0n);
  const t = await s.totals();
  // Everything the treasury's accounts hold: seed, deposit, and the round's profit.
  expect(t.users + t.holds + t.treasury + t.fees).toBe(micro(1033));
  expect(t.users + t.holds + t.treasury + t.fees + t.venue).toBe(0n);
  // Booked, the lane waits to be topped back up before anyone else leases it.
  expect(await s.tendable()).toEqual([lane]);
  await s.release(lane, micro(200));
  expect((await s.lanes()).every((l) => l.boostId === null && l.balance === micro(200))).toBe(true);
  expect(await s.tendable()).toEqual([]);
});

run("a lane without enough float, or not tended yet, is never leased", async () => {
  const s = await fresh();
  await s.credit(alice, micro(100), "dep:h");
  await s.release(101, micro(50));
  await s.syncLanes([103]);
  const { lane } = await s.reserve({ id: id("t1"), address: alice, accountIndex: 5, market: "BTC", stake: micro(10), boost: micro(50), cap: micro(500) });
  // 101 holds too little for $60, 103 has never been tended: only 102 will do.
  expect(lane).toBe(102);
  // A lane whose round is still open is never freed, whatever asks.
  await s.release(102, micro(200));
  expect((await s.lanes()).find((l) => l.lane === 102)?.boostId).toBe(id("t1"));
});

run("a loss past the stake is carried by the treasury", async () => {
  const s = await fresh();
  await s.credit(alice, micro(10), "dep:a");
  await s.reserve({ id: id("r2"), address: alice, accountIndex: 5, market: "BTC", stake: micro(10), boost: micro(50), cap: micro(500) });
  await s.book(id("r2"), settle(micro(10), micro(50), micro(47), 0.3, 0.01));
  expect(await s.balance(userAccount(alice))).toBe(0n);
  expect(await s.balance("treasury")).toBe(micro(997));
});

run("the checks that protect money: balance, one round each, the cap, the lanes", async () => {
  const s = await fresh();
  await expect(s.reserve({ id: id("x"), address: alice, accountIndex: 5, market: "BTC", stake: micro(10), boost: micro(50), cap: micro(500) })).rejects.toThrow(/not reached skech/);
  await s.credit(alice, micro(100), "dep:b");
  await s.credit(bob, micro(100), "dep:c");
  await s.reserve({ id: id("a1"), address: alice, accountIndex: 5, market: "BTC", stake: micro(10), boost: micro(50), cap: micro(100) });
  await expect(s.reserve({ id: id("a2"), address: alice, accountIndex: 5, market: "BTC", stake: micro(10), boost: micro(50), cap: micro(500) })).rejects.toThrow(/already/);
  // 50 out, 50 more would make 100: at the cap is allowed, past it is not.
  await expect(s.reserve({ id: id("b1"), address: bob, accountIndex: 6, market: "BTC", stake: micro(12), boost: micro(60), cap: micro(100) })).rejects.toThrow(/full/);
  await s.reserve({ id: id("b2"), address: bob, accountIndex: 6, market: "BTC", stake: micro(10), boost: micro(50), cap: micro(100) });
  // Two lanes, both leased.
  await s.credit("0x000000000000000000000000000000000000ca01", micro(100), "dep:d");
  await expect(s.reserve({ id: id("c1"), address: "0x000000000000000000000000000000000000ca01", accountIndex: 8, market: "BTC", stake: micro(10), boost: micro(50), cap: micro(1000) })).rejects.toThrow(/lane/);
  await s.refund(id("a1"), null);
  expect(await s.balance(userAccount(alice))).toBe(micro(100));
  expect(await s.outstanding()).toBe(micro(50));
});

run("two withdrawals cannot spend one balance, and a failed one is undone", async () => {
  const s = await fresh();
  await s.credit(alice, micro(15), "dep:e");
  const both = await Promise.all([s.withdraw(alice, micro(10), "w1"), s.withdraw(alice, micro(10), "w2")]);
  expect(both.filter(Boolean)).toHaveLength(1);
  expect(await s.balance(userAccount(alice))).toBe(micro(5));
  await s.unwithdraw(alice, micro(10), both[0] ? "w1" : "w2");
  expect(await s.balance(userAccount(alice))).toBe(micro(15));
});

run("money nobody is using is found to send home, and money in a round is not", async () => {
  const s = await fresh();
  await s.credit(alice, micro(12), "dep:f");
  await s.credit(bob, micro(12), "dep:g");
  await Bun.sleep(20);
  expect(await s.idle(3600)).toEqual([]);
  await s.reserve({ id: id("i1"), address: bob, accountIndex: 6, market: "BTC", stake: micro(10), boost: micro(50), cap: micro(500) });
  await Bun.sleep(20);
  expect(await s.idle(0)).toEqual([{ address: alice, amount: micro(12) }]);
});
