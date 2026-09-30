/**
 * With RELAYER_ENGINE_SIGNER set, an engine that signs as anyone else is not listened to: no signer taken from
 * it, and none of its trades folded into the bars the relayer settles on.
 */
import { afterAll, expect, test } from "bun:test";
import { Engine } from "./engine";

const EXPECTED = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
let signer = "0x000000000000000000000000000000000000dEaD";
const engine = Bun.serve({
  port: 0,
  fetch: (req, server) => (server.upgrade(req) ? undefined : new Response("ws", { status: 426 })),
  websocket: {
    open: (ws) => {
      ws.send(JSON.stringify({ type: "hello", signer, typedData: { domain: { chainId: 31337, verifyingContract: "0x0000000000000000000000000000000000000001" } } }));
      ws.send(JSON.stringify({ type: "history", trades: [[1, 1_790_000_000_000, 80_000]] }));
    },
    message: () => {},
  },
});
afterAll(() => engine.stop(true));

test("an engine signing as someone else is refused; the expected one is heard", async () => {
  const logs: string[] = [];
  const wrong = new Engine(`ws://127.0.0.1:${engine.port}`, (s) => logs.push(s), EXPECTED);
  wrong.start();
  await Bun.sleep(200);
  wrong.stop();
  expect(wrong.signer).toBeNull();
  expect(wrong.book.bars).toHaveLength(0);
  expect(logs.some((l) => l.includes("not listening to it"))).toBe(true);

  signer = EXPECTED;
  const right = new Engine(`ws://127.0.0.1:${engine.port}`, () => {}, EXPECTED.toLowerCase() as `0x${string}`);
  right.start();
  await Bun.sleep(200);
  right.stop();
  expect(right.signer).toBe(EXPECTED);
  expect(right.book.bars.length).toBeGreaterThan(0);
});
