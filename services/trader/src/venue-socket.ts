/**
 * One WebSocket to the venue, for everything that is not a cold read.
 *
 * Positions and fills are pushed on public account channels, the book's best
 * prices on `ticker`, and signed transactions go the other way on the same
 * socket and are answered with the id they were sent under. That leaves one
 * network round trip between deciding to trade and the venue saying yes,
 * where the REST path had three: a position read, a nonce the signer fetched
 * for itself, and the send.
 *
 * Formats were read off testnet with transactions the venue rejects before
 * execution (a stale nonce): a single send takes `tx_info` as an object; a
 * batch takes `tx_types` and `tx_infos` as JSON strings, the infos being the
 * signer's own strings. A nonce the venue does not expect is code 21104.
 */

export class VenueError extends Error {
  constructor(message: string, readonly code: number | null) {
    super(message);
  }
  get badNonce() {
    return this.code === 21104 || /nonce/i.test(this.message);
  }
}

/** Sent, and no answer: the venue may or may not have it. Never retried blindly. */
export class VenueTimeout extends Error {}

type Handler = (message: Record<string, unknown>) => void;
type Waiter = { resolve: (m: Record<string, unknown>) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

export class VenueSocket {
  private ws: WebSocket | null = null;
  private readonly handlers = new Map<string, Set<Handler>>();
  private readonly waiting = new Map<string, Waiter>();
  private backoff = 250;
  private heard = 0;
  private closed = false;
  private sequence = 0;
  private opened: Promise<void> | null = null;
  private clock: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly url: string, private readonly timeoutMs = 4000) {}

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  start() {
    this.closed = false;
    this.connect();
    // Lighter drops a socket that says nothing; a ping also tells us ours is dead.
    this.clock ??= setInterval(() => {
      if (!this.connected) return;
      if (Date.now() - this.heard > 45_000) this.ws?.close();
      else this.ws?.send(JSON.stringify({ type: "ping" }));
    }, 20_000);
  }

  stop() {
    this.closed = true;
    if (this.clock) clearInterval(this.clock);
    this.clock = null;
    this.ws?.close();
  }

  /** Wait for the socket, briefly. Callers fall back to HTTP rather than wait long. */
  async ready(ms = 1500) {
    if (this.connected) return true;
    if (!this.opened) return false;
    return Promise.race([this.opened.then(() => true), Bun.sleep(ms).then(() => false)]);
  }

  /** Channel names come back with a colon where they were subscribed with a slash. */
  private static key(channel: string) {
    return channel.replace("/", ":");
  }

  subscribe(channel: string, handler: Handler): () => void {
    const key = VenueSocket.key(channel);
    const set = this.handlers.get(key) ?? new Set();
    const first = set.size === 0;
    set.add(handler);
    this.handlers.set(key, set);
    if (first && this.connected) this.ws!.send(JSON.stringify({ type: "subscribe", channel }));
    return () => {
      set.delete(handler);
      if (set.size === 0) {
        this.handlers.delete(key);
        if (this.connected) this.ws!.send(JSON.stringify({ type: "unsubscribe", channel }));
      }
    };
  }

  /** One signed transaction. Resolves when the venue accepts it. */
  sendTx(txType: number, txInfo: string) {
    return this.request("jsonapi/sendtx", { tx_type: txType, tx_info: JSON.parse(txInfo) });
  }

  /** Up to fifteen, in nonce order, in one message and one round trip. */
  sendBatch(txTypes: number[], txInfos: string[]) {
    return this.request("jsonapi/sendtxbatch", { tx_types: JSON.stringify(txTypes), tx_infos: JSON.stringify(txInfos) });
  }

  private request(type: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.connected) return Promise.reject(new Error("venue socket not connected"));
    const id = `${Date.now().toString(36)}-${this.sequence++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new VenueTimeout(`no answer from the venue in ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.waiting.set(id, { resolve, reject, timer });
      this.ws!.send(JSON.stringify({ type, data: { id, ...data } }));
    });
  }

  private connect() {
    if (this.closed) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    let open!: () => void;
    this.opened = new Promise((r) => (open = r));
    ws.addEventListener("open", () => {
      this.backoff = 250;
      this.heard = Date.now();
      for (const key of this.handlers.keys()) ws.send(JSON.stringify({ type: "subscribe", channel: key.replace(":", "/") }));
      open();
    });
    ws.addEventListener("message", (e) => {
      this.heard = Date.now();
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (m.type === "ping") return ws.send(JSON.stringify({ type: "pong" }));
      if (typeof m.id === "string" && this.waiting.has(m.id)) {
        const w = this.waiting.get(m.id)!;
        this.waiting.delete(m.id);
        clearTimeout(w.timer);
        const err = m.error as { code?: number; message?: string } | undefined;
        if (err) w.reject(new VenueError(`lighter: ${err.code ?? ""} ${err.message ?? "rejected"}`.trim(), err.code ?? null));
        else if (typeof m.code === "number" && m.code !== 200) w.reject(new VenueError(`lighter: ${m.code} ${String(m.message ?? "")}`, m.code));
        else w.resolve(m);
        return;
      }
      if (typeof m.channel === "string") for (const h of this.handlers.get(m.channel) ?? []) h(m);
    });
    ws.addEventListener("close", () => {
      // Anything still waiting went out on a socket that is gone: its fate is unknown.
      for (const [id, w] of this.waiting) {
        clearTimeout(w.timer);
        w.reject(new VenueTimeout("venue socket closed before answering"));
        this.waiting.delete(id);
      }
      if (this.closed) return;
      setTimeout(() => this.connect(), this.backoff + Math.random() * 100);
      this.backoff = Math.min(10_000, this.backoff * 2);
    });
    ws.addEventListener("error", () => ws.close());
  }
}

/** The transaction hashes in an answer, whatever shape it came in. */
export function hashesOf(m: Record<string, unknown>): string[] {
  const data = (m.data ?? m) as Record<string, unknown>;
  const many = data.tx_hash ?? data.tx_hashes ?? m.tx_hash ?? m.tx_hashes;
  if (Array.isArray(many)) return many.map(String);
  if (typeof many === "string") return [many];
  return [];
}
