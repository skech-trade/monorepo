/**
 * What the network costs from wherever this runs. Run it on a laptop, then on
 * the box you would deploy to, and compare.
 *
 *   bun run bench:network            # testnet
 *   SKECH_NETWORK=mainnet bun run bench:network
 *
 * Read-only: REST reads, and WebSocket sends that the venue rejects before
 * execution (an empty transaction), which is the same round trip an order
 * takes to be accepted.
 */
const net = process.env.SKECH_NETWORK === "mainnet" ? "mainnet" : "testnet";
const base = `https://${net}.zklighter.elliot.ai`;
const market = net === "mainnet" ? 1 : 4096;
const N = Number(process.env.BENCH_N ?? 20);

function stats(label: string, samples: number[]) {
  const s = [...samples].sort((a, b) => a - b);
  const at = (p: number) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  console.log(`${label.padEnd(44)} p50 ${at(0.5).toFixed(1).padStart(7)}ms  p95 ${at(0.95).toFixed(1).padStart(7)}ms  n=${s.length}`);
}

console.log(`\n# Network from this host to Lighter ${net}\n`);

const cold = performance.now();
await fetch(`${base}/api/v1/orderBookDetails?market_id=${market}`).then((r) => r.text());
console.log(`${"first HTTPS request (DNS + TCP + TLS)".padEnd(44)} ${(performance.now() - cold).toFixed(1)}ms`);

const rest: number[] = [];
for (let i = 0; i < N; i++) {
  const t = performance.now();
  await fetch(`${base}/api/v1/orderBookDetails?market_id=${market}`).then((r) => r.text());
  rest.push(performance.now() - t);
}
stats("REST read, warm connection", rest);

const ws = new WebSocket(`${base.replace("https", "wss")}/stream`);
const opened = performance.now();
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
console.log(`${"WebSocket connect".padEnd(44)} ${(performance.now() - opened).toFixed(1)}ms`);

const waiting = new Map<string, number>();
const sends: number[] = [];
ws.addEventListener("message", (e) => {
  const m = JSON.parse(String(e.data));
  const at = waiting.get(m.id);
  if (at !== undefined) {
    sends.push(performance.now() - at);
    waiting.delete(m.id);
  }
});
for (let i = 0; i < N; i++) {
  const id = `bench-${i}`;
  waiting.set(id, performance.now());
  ws.send(JSON.stringify({ type: "jsonapi/sendtx", data: { id, tx_type: 14, tx_info: {} } }));
  await Bun.sleep(150);
}
await Bun.sleep(1500);
stats("send a transaction over WS, venue answers", sends);
ws.close();
console.log("\nOne order is one of these round trips; a fill then waits on the venue's own taker delay.\n");
process.exit(0);
