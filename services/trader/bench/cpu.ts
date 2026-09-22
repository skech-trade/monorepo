/**
 * What our own code costs on the order path, with the network taken out.
 *
 *   bun run bench:cpu
 *
 * Signing uses a throwaway key and an explicit nonce, so nothing is sent and
 * nothing is fetched. The scheduler runs against an account that answers
 * instantly, so what is timed is the decision and the bookkeeping only.
 */
import { SAMPLES, shapeOf } from "@skech/core/shape";
import type { Exec, OrderRequest, Position, Sent, VenueFill } from "../src/executor";
import { segmentsFrom } from "../src/plan";
import { Rounds } from "../src/rounds";
import { generateApiKey, Signer } from "../src/signer";

process.env.NODE_ENV = "test";

function stats(label: string, samples: number[]) {
  const s = [...samples].sort((a, b) => a - b);
  const at = (p: number) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  const fmt = (ms: number) => (ms < 1 ? `${(ms * 1000).toFixed(1)}µs` : `${ms.toFixed(2)}ms`);
  console.log(`${label.padEnd(44)} p50 ${fmt(at(0.5)).padStart(9)}  p99 ${fmt(at(0.99)).padStart(9)}  n=${s.length}`);
  return at(0.5);
}

function time(fn: () => void, n: number) {
  for (let i = 0; i < Math.min(50, n); i++) fn();
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    fn();
    out.push(performance.now() - t);
  }
  return out;
}

const key = generateApiKey();
const signer = Signer.open({ url: "https://testnet.zklighter.elliot.ai", privateKey: key.privateKey, chainId: 300, accountIndex: 1, apiKeyIndex: 2, check: false });
let nonce = 1n;
const order = () => signer.createOrder({ marketIndex: 4096, clientOrderIndex: nonce, baseAmount: 3469n, price: 873000, isAsk: false, nonce: nonce++ });

console.log("\n# CPU cost per step (no network)\n");
const sign = stats("sign one order (Lighter's Go signer, FFI)", time(order, 2000));
stats("sign a flip (close + open)", time(() => { order(); order(); }, 1000));
const tx = order().txInfo;
stats("build the WS message for one order", time(() => JSON.stringify({ type: "jsonapi/sendtx", data: { id: "x", tx_type: 14, tx_info: JSON.parse(tx) } }), 5000));

const pts = [0, 0.15, 0.24, 0.34, 0.51, 0.55, 0.78, 1].map((t, i) => ({ t, price: 86450 + [0, 11, 4, 20, 10, 26, 14, 38][i] }));
stats("compile a drawing to legs (shapeOf)", time(() => shapeOf(pts, 86450), 5000));
const shape = shapeOf(pts, 86450)!;
stats("legs to scheduled segments", time(() => segmentsFrom(shape, Date.now(), 60), 5000));
console.log(`  (${shape.legs.length} legs from ${SAMPLES} samples)`);

/** An account that acks and fills at once, so only our side is on the clock. */
class Instant implements Exec {
  readonly accountIndex = 7;
  pos: Position = { size: 0, avgEntry: 0, unrealised: 0, imf: null, marginMode: null, at: 0 };
  private readonly pf = new Set<(p: Position) => void>();
  private readonly ff = new Set<(f: VenueFill) => void>();
  position() { return this.pos; }
  latency() { return 0; }
  async prepare() {}
  onPosition(fn: (p: Position) => void) { this.pf.add(fn); return () => this.pf.delete(fn); }
  onFill(fn: (f: VenueFill) => void) { this.ff.add(fn); return () => this.ff.delete(fn); }
  async fillsSince() { return []; }
  private trade = 0;
  async submit(orders: OrderRequest[]): Promise<Sent> {
    const now = Date.now();
    queueMicrotask(() => {
      for (const o of orders) {
        const signed = o.isAsk ? -o.size : o.size;
        this.pos = { ...this.pos, size: Math.round((this.pos.size + (o.reduceOnly ? -this.pos.size : signed)) * 1e9) / 1e9 };
        const side = o.isAsk ? "ask" : "bid";
        const f = { trade_id: ++this.trade, tx_hash: "", timestamp: now, price: "86450", size: String(o.size), ask_account_id: o.isAsk ? 7 : 9, bid_account_id: o.isAsk ? 9 : 7, [`${side}_client_id_str`]: String(o.clientOrderIndex), receivedAt: Date.now() };
        for (const fn of this.ff) fn(f as VenueFill);
      }
      for (const fn of this.pf) fn(this.pos);
    });
    return { signedAt: now, sentAt: now, ackAt: now, hashes: [], via: "ws", withLeverage: false, worst: [] };
  }
}

const market = { id: 4096, last: 86450, symbol: "BTC", minBase: 0.0002, minQuote: 10, sizeDecimals: 5, priceDecimals: 1 };
const opens: number[] = [];
for (let i = 0; i < 200; i++) {
  const book = new Rounds(() => market, { feedUrl: null });
  const t = performance.now();
  const r = await book.open({ pts, stake: 100, leverage: 30, seconds: 60, exits: { lose: null, gain: null } }, new Instant());
  opens.push(performance.now() - t);
  void r;
}
const open = stats("open a round: validate, plan, dispatch", opens);

console.log(`\nOur side of one order, sign + dispatch: ~${(sign + open).toFixed(2)}ms. Compare with the network numbers from bench:network.\n`);
process.exit(0);
