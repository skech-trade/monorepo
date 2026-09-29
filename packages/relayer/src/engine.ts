/**
 * The relayer as a client of the engine: the last ten minutes of trades on
 * connect, then every signed trade, folded into the same one-second bars the
 * app folds. Also the engine's clock: quotes and bars are timed on it.
 */
import { BarBook } from "@skech/core/bars";
import type { Address, Hex } from "viem";

export type PriceQuote = { price: number; priceE8: bigint; time: number; signature: Hex };
type Message =
  | { type: "hello"; signer: Address; typedData: { domain: { chainId: number; verifyingContract: Address } } }
  | { type: "history"; trades: [id: number, t: number, p: number][] }
  | { type: "price"; id: number; t: number; p: number; message: { price: string; time: number } | null; signature: Hex | null }
  | { type: "beat"; t: number };

export class Engine {
  book = new BarBook(660, 4000);
  signer: Address | null = null;
  domain: { chainId: number; verifyingContract: Address } | null = null;
  quote: PriceQuote | null = null;
  connected = false;
  /** The engine's clock (Coinbase's) minus this one's. */
  skew = 0;
  private lastId = 0;
  private heard = 0;
  private ws: WebSocket | null = null;
  private stopped = false;
  private backoff = 500;

  constructor(private readonly url: string, private readonly log: (s: string) => void) {}

  now() {
    return Date.now() + this.skew;
  }

  start() {
    this.connect();
    setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN && Date.now() - this.heard > 5000) {
        this.log("engine: silent for 5 s, reconnecting");
        const dead = this.ws;
        this.ws = null;
        dead.onclose = null;
        dead.close();
        this.connected = false;
        this.connect();
      }
      // Quiet seconds still pass.
      if (this.connected) this.book.closeQuiet(this.now());
    }, 200);
  }

  stop() {
    this.stopped = true;
    this.ws?.close();
  }

  private connect() {
    if (this.stopped) return;
    const sock = new WebSocket(this.url);
    this.ws = sock;
    this.heard = Date.now();
    sock.onopen = () => {
      this.backoff = 500;
      this.connected = true;
      this.log(`engine: connected to ${this.url}`);
    };
    sock.onmessage = (e) => {
      this.heard = Date.now();
      let msg: Message;
      try {
        msg = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (msg.type === "hello") {
        this.signer = msg.signer;
        this.domain = msg.typedData.domain;
        this.log(`engine: signs as ${msg.signer} for chain ${msg.typedData.domain.chainId}, contract ${msg.typedData.domain.verifyingContract}`);
      } else if (msg.type === "history") {
        // A history that reaches further back than our bars (the engine had not backfilled when we first
        // connected) replaces them: bars cannot be folded in behind the first one.
        const first = msg.trades[0]?.[1];
        if (first !== undefined && (this.book.bars.length === 0 || first < this.book.bars[0].t - 60_000)) {
          this.book = new BarBook(660, 4000);
          this.lastId = 0;
        }
        for (const [id, t, p] of msg.trades) {
          if (id <= this.lastId) continue;
          this.lastId = id;
          this.book.fold(t, p);
        }
        if (this.book.bars.length < 320) {
          this.log(`engine: history is ${this.book.bars.length} bars, not the five minutes pricing needs; asking again in 5 s`);
          setTimeout(() => {
            if (this.ws === sock && sock.readyState === WebSocket.OPEN) sock.close();
          }, 5000);
        } else this.log(`engine: ${this.book.bars.length} bars of history`);
      } else if (msg.type === "price") {
        if (msg.id <= this.lastId || !(msg.p > 0)) return;
        this.lastId = msg.id;
        const sample = msg.t + 40 - Date.now();
        this.skew = this.skew === 0 ? sample : this.skew * 0.98 + sample * 0.02;
        if (msg.message && msg.signature) this.quote = { price: msg.p, priceE8: BigInt(msg.message.price), time: msg.message.time, signature: msg.signature };
        this.book.fold(msg.t, msg.p);
      }
    };
    sock.onclose = () => {
      if (this.ws === sock) this.connected = false;
      if (this.stopped || this.ws !== sock) return;
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(10_000, this.backoff * 2);
    };
    sock.onerror = () => sock.close();
  }

  /** Whether there are enough fresh bars to price on. */
  ready() {
    const last = this.book.last;
    return this.connected && !!last && this.book.bars.length > 320 && this.now() - (this.book.ticks.at(-1)?.t ?? 0) < 5000;
  }
}
