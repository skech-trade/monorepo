import { expect, test } from "bun:test";
import type { Bar } from "./bars";
import { LighterFeed } from "./lighter";

test("streams forming-bar corrections and the final previous bar without waiting for another second", async () => {
  const updates: Bar[] = [];
  let send: ((trades: { timestamp: number; price: string; size: string }[]) => void) | undefined;
  const server = Bun.serve({
    port: 0,
    fetch(req, server) {
      if (server.upgrade(req)) return;
      return new Response("WebSocket required", { status: 400 });
    },
    websocket: {
      open(ws) { send = (trades) => ws.send(JSON.stringify({ channel: "trade:1", trades })); },
      message() {},
    },
  });
  const feed = new LighterFeed({ url: `ws://localhost:${server.port}`, marketId: 1, onBar: (bar) => updates.push(bar) });
  const waitFor = async (condition: () => boolean) => {
    const start = Date.now();
    while (!condition()) {
      if (Date.now() - start > 2000) throw new Error("Feed update timed out");
      await Bun.sleep(10);
    }
  };
  try {
    feed.start();
    await waitFor(() => !!send);
    // Keep the real wall clock behind these trades so it cannot open a test bar.
    const second = Math.floor(Date.now() / 1000) + 10;
    send!([{ timestamp: second * 1000, price: "80000", size: "1" }]);
    await waitFor(() => updates.some((bar) => bar.t === second));
    send!([{ timestamp: second * 1000 + 100, price: "80040", size: "2" }]);
    await waitFor(() => updates.some((bar) => bar.t === second && bar.c === 80040));
    expect(feed.bars.all()).toHaveLength(1);
    send!([
      { timestamp: second * 1000 + 499, price: "80070", size: "1" },
      { timestamp: (second + 0.5) * 1000, price: "80020", size: "1" },
    ]);
    await waitFor(() => updates.some((bar) => bar.t === second + 0.5));
    expect(updates.filter((bar) => bar.t === second).at(-1)).toMatchObject({ c: 80070, v: 4 });
    expect(updates.at(-1)).toMatchObject({ t: second + 0.5, o: 80070, c: 80020 });
    feed.bars.tick((second + 2) * 1000);
    updates.length = 0;
    send!([{ timestamp: second * 1000 + 900, price: "80100", size: "1" }]);
    await waitFor(() => updates.some((bar) => bar.t === second + 2 && bar.c === 80100));
    expect(updates.map(bar => bar.t)).toEqual([second + 0.5, second + 1, second + 1.5, second + 2]);
    expect(updates.every(bar => bar.c === 80100)).toBe(true);
  } finally {
    feed.stop();
    server.stop(true);
  }
});

test("answers upstream pings and deduplicates replayed trade IDs", async () => {
  let send: ((data: unknown) => void) | undefined;
  let pong = false;
  const server = Bun.serve({
    port: 0,
    fetch(req, server) {
      if (server.upgrade(req)) return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      open(ws) {
        send = (d) => ws.send(JSON.stringify(d));
      },
      message(_ws, data) {
        if (JSON.parse(String(data)).type === "pong") pong = true;
      },
    },
  });
  const feed = new LighterFeed({ url: `ws://localhost:${server.port}`, marketId: 1 });
  const wait = async (fn: () => boolean) => {
    for (let i = 0; i < 100 && !fn(); i++) await Bun.sleep(5);
    expect(fn()).toBe(true);
  };
  try {
    feed.start();
    await wait(() => !!send);
    send!({ type: "ping" });
    await wait(() => pong);
    const t = Date.now() + 10000;
    const trade = { trade_id: 42, timestamp: t, price: "100", size: "2" };
    send!({ channel: "trade:1", trades: [trade] });
    await wait(() => !!feed.bars.open);
    send!({ channel: "trade:1", trades: [trade] });
    await Bun.sleep(20);
    expect(feed.bars.open?.v).toBe(2);
  } finally {
    feed.stop();
    server.stop(true);
  }
});

test("mark candles keep moving without testnet trades and never mix execution prices", async () => {
  let send: ((data: unknown) => void) | undefined;
  const updates: Bar[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req, server) { if (server.upgrade(req)) return; return new Response(null, { status: 400 }); },
    websocket: { open(ws) { send = data => ws.send(JSON.stringify(data)); }, message() {} },
  });
  const feed = new LighterFeed({ url: `ws://localhost:${server.port}`, marketId: 4096, priceSource: "mark", onBar: bar => updates.push(bar) });
  const wait = async (fn: () => boolean) => { for (let i = 0; i < 100 && !fn(); i++) await Bun.sleep(5); expect(fn()).toBe(true); };
  try {
    feed.start(); await wait(() => !!send);
    expect(feed.connected).toBe(false);
    send!({ channel: "market_stats:4096", market_stats: { mark_price: "86400" } });
    await wait(() => updates.at(-1)?.c === 86400);
    send!({ channel: "trade:4096", trades: [{ price: "86661.7", size: "1", timestamp: Date.now() }] });
    send!({ channel: "market_stats:4096", market_stats: { mark_price: "86410" } });
    await wait(() => updates.at(-1)?.c === 86410);
    expect(feed.connected).toBe(true);
    expect(feed.bars.all().every(bar => bar.v === 0 && bar.h <= 86410)).toBe(true);
  } finally { feed.stop(); server.stop(true); }
});

test("a message that is valid JSON but not an object is ignored, not thrown", async () => {
  let send: ((raw: string) => void) | undefined;
  const server = Bun.serve({
    port: 0,
    fetch(req, server) {
      if (server.upgrade(req)) return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      open(ws) {
        send = (raw) => ws.send(raw);
      },
      message() {},
    },
  });
  const feed = new LighterFeed({ url: `ws://localhost:${server.port}`, marketId: 1 });
  const wait = async (fn: () => boolean) => {
    for (let i = 0; i < 100 && !fn(); i++) await Bun.sleep(5);
    expect(fn()).toBe(true);
  };
  try {
    feed.start();
    await wait(() => !!send);
    for (const raw of ["null", "7", '"trade"', `{"channel":"trade:1","trades":[null,7]}`]) send!(raw);
    send!(JSON.stringify({ channel: "trade:1", trades: [{ timestamp: Date.now() + 10_000, price: "100", size: "1" }] }));
    await wait(() => feed.bars.open?.c === 100);
  } finally {
    feed.stop();
    server.stop(true);
  }
});
