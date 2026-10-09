import { useEffect, useRef, useState } from "react";
import { RELAYER_URL } from "./config";

/**
 * The Solana relayer: where the app sends what it draws, signed by the session key, and hears back what the chain
 * made of it; and where every transaction the wallet signs is built and sent, the relayer paying. One socket,
 * reopened when it drops; every message is JSON with the chain's numbers as strings. The messages are in
 * `packages/relayer/README.md`: addresses in base58, and `build` / `submit` for what the wallet signs.
 */

export type Hello = {
  type: "hello";
  chain: "solana";
  cluster: "devnet" | "mainnet-beta" | "localnet";
  label: string;
  program: string;
  game: string;
  usdc: string;
  lookupTable: string;
  /** What every signed piece starts with: this deployment on this cluster, hex. */
  domain: string;
  oracle: string;
  relayer: string;
  engineSigner: string | null;
  market: { id: number; name: string };
  difficulty: number | null;
  lateMs: number;
  units: string[] | null;
  terms: { minPerDot: string; maxPerDot: string; maxPieceStake: string; maxPriceAgeMs: number; feeBps: number; profitFeeBps: number } | null;
  faucet: string | null;
  activity: boolean;
};
export type Account = {
  player: string;
  balance: string;
  session: { key: string; validUntil: string; allowance: string } | null;
  owed: string;
  /** USDC in the wallet itself, and how much of it the game may sweep in. */
  wallet: { usdc: string; approved: string };
};
export type Band = { second: number; lo: string; hi: string; stake: string; rung: number };
export type PlacedMsg = { type: "placed"; betId: string; player: string; drawing: string; index: number; openAt: string; staked: string; fee: string; refunded: string; sections: Band[]; tx: string };
export type RefusedMsg = { type: "refused"; betId?: string; player: string; drawing: string; index: number; why: string; tx?: string };
export type SettledMsg = { type: "settled"; betId: string; player: string; hitMask: number; missMask: number; paid: string; owed: string; closed: boolean; tx: string };
export type AckMsg = { type: "ack"; ok: boolean; betId?: string; why?: string; drawing?: string; index?: number };
export type ActivityMsg = { type: "activity"; player: string | null; txs: number; recent: { signature: string; time: number | null }[]; explorer?: string; counting: boolean; progress: number };
/** What the wallet signs and the relayer pays for. */
export type Kind = "session" | "deposit" | "withdraw" | "revoke";
export type BuiltMsg = { type: "built"; kind: string; id?: string; tx?: string; ok?: false; why?: string };
export type SubmittedMsg = { type: "submitted"; id: string; kind?: string; ok: boolean; tx?: string; why?: string };
export type Incoming =
  | Hello
  | ({ type: "account" } & Account)
  | PlacedMsg
  | RefusedMsg
  | SettledMsg
  | AckMsg
  | ActivityMsg
  | BuiltMsg
  | SubmittedMsg
  | { type: "owed"; value: string }
  | { type: "error"; why: string };

type Handler = (m: Incoming) => void;
const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));

export class RelayerClient {
  private ws: WebSocket | null = null;
  private handlers = new Set<Handler>();
  private stopped = false;
  private backoff = 500;
  hello: Hello | null = null;
  connected = false;
  player: string | null = null;

  constructor(private readonly url = RELAYER_URL) {}

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    this.ws?.close();
  }

  on(h: Handler) {
    this.handlers.add(h);
    return () => this.handlers.delete(h);
  }

  send(msg: unknown): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(json(msg));
    return true;
  }

  /** Send, and resolve with the first message `match` accepts, or null after `ms`. */
  request<T extends Incoming>(msg: unknown, match: (m: Incoming) => m is T, ms = 20_000): Promise<T | null> {
    return new Promise((resolve) => {
      const off = this.on((m) => {
        if (!match(m)) return;
        off();
        clearTimeout(timer);
        resolve(m);
      });
      const timer = setTimeout(() => (off(), resolve(null)), ms);
      if (!this.send(msg)) {
        off();
        clearTimeout(timer);
        resolve(null);
      }
    });
  }

  /**
   * A transaction the wallet signs and the relayer pays for: built there, signed here by `sign` (Privy's
   * embedded wallet or a Mobile Wallet Adapter wallet), sent there. What went wrong, if anything.
   */
  async transact(kind: Kind, params: Record<string, unknown>, sign: (base64: string) => Promise<string>): Promise<{ ok: true; tx: string } | { ok: false; why: string }> {
    return this.transactAll([{ kind, params }], async ([t]) => [await sign(t)]);
  }

  /**
   * Several, signed together and sent in order: a wallet on the phone opens once for all of them, not once each,
   * which otherwise reads as the wallet never handing back. Stops at the first that fails.
   */
  async transactAll(steps: { kind: Kind; params: Record<string, unknown> }[], signAll: (base64s: string[]) => Promise<string[]>): Promise<{ ok: true; tx: string } | { ok: false; why: string }> {
    const built: BuiltMsg[] = [];
    for (const { kind, params } of steps) {
      const b = await this.request({ type: "build", kind, player: this.player, ...params }, (m): m is BuiltMsg => m.type === "built" && m.kind === kind, 15_000);
      if (!b?.id || !b.tx) return fail(kind, "build", b?.why ?? "The relayer did not answer");
      built.push(b);
    }
    let signed: string[];
    try {
      signed = await signAll(built.map((b) => b.tx!));
    } catch (e) {
      return fail(steps.map((x) => x.kind).join("+"), "sign", String((e as Error).message ?? e) || "Not signed");
    }
    let last = "";
    for (const [i, b] of built.entries()) {
      const done = await this.request({ type: "submit", id: b.id, tx: signed[i], ...(steps[i].params.approve ? { approve: true } : {}) }, (m): m is SubmittedMsg => m.type === "submitted" && m.id === b.id, 60_000);
      if (!done) return fail(steps[i].kind, "submit", "No answer from the chain");
      if (!done.ok || !done.tx) return fail(steps[i].kind, "submit", done.why ?? "Not sent");
      last = done.tx;
    }
    return { ok: true, tx: last };
  }

  /** Follow one player's account and bets. */
  watch(player: string | null) {
    this.player = player;
    if (player) this.send({ type: "watch", player });
  }

  private connect() {
    if (this.stopped) return;
    const sock = new WebSocket(this.url);
    this.ws = sock;
    sock.onopen = () => {
      console.info(`[relayer] connected to ${this.url}`);
      this.backoff = 500;
      this.connected = true;
      if (this.player) this.send({ type: "watch", player: this.player });
      this.emit({ type: "error", why: "" });
    };
    sock.onmessage = (e) => {
      let m: Incoming;
      try {
        m = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (m.type === "hello") this.hello = m;
      trace(m);
      this.emit(m);
    };
    sock.onclose = (e) => {
      if (!this.stopped) console.warn(`[relayer] connection closed (${e.code}${e.reason ? ` ${e.reason}` : ""}); trying again in ${this.backoff}ms`);
      if (this.ws === sock) this.connected = false;
      if (this.stopped || this.ws !== sock) return;
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(10_000, this.backoff * 2);
      this.emit({ type: "error", why: "" });
    };
    sock.onerror = () => sock.close();
  }

  private emit(m: Incoming) {
    for (const h of this.handlers) h(m);
  }
}

/** One relayer for the app, following `player`. */
export function useRelayer(player: string | null, enabled: boolean) {
  const [client] = useState(() => new RelayerClient());
  const [hello, setHello] = useState<Hello | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [connected, setConnected] = useState(false);
  const started = useRef(false);
  useEffect(() => {
    if (!enabled) return;
    if (!started.current) {
      started.current = true;
      client.start();
    }
    const off = client.on((m) => {
      setConnected(client.connected);
      if (m.type === "hello") setHello(m);
      else if (m.type === "account") setAccount(m);
    });
    return () => {
      off();
    };
  }, [client, enabled]);
  useEffect(() => {
    if (enabled) client.watch(player);
  }, [client, player, enabled]);
  const own = player && account && account.player === player ? account : null;
  return { client, hello, account: own, connected };
}

/** A wallet transaction that did not go through, said in the log as well: the screen only has room for a line. */
function fail(kind: string, at: "build" | "sign" | "submit", why: string): { ok: false; why: string } {
  console.warn(`wallet transaction: ${kind} failed at ${at}:`, why);
  return { ok: false, why };
}

/**
 * What the relayer says about this player's pieces and money, in the log: on a phone in someone's hand this is the
 * only way to see why a line was refused or never landed. Prices and the chart's stream are left out; they are many.
 */
function trace(m: Incoming) {
  switch (m.type) {
    case "hello":
      console.info(`[relayer] hello: ${m.cluster} ${m.label}, game ${m.game}, difficulty ${m.difficulty}, relayer ${m.relayer}`);
      break;
    case "ack":
      if (m.ok) console.info(`[relayer] piece ${m.drawing}:${m.index} taken${m.betId ? `, bet ${m.betId}` : ""}`);
      else console.warn(`[relayer] piece ${m.drawing}:${m.index} refused: ${m.why}`);
      break;
    case "placed":
      console.info(`[relayer] placed ${m.drawing}:${m.index} as bet ${m.betId}: staked ${m.staked}, fee ${m.fee}, refunded ${m.refunded}, ${m.sections.length} sections, tx ${m.tx}`);
      break;
    case "refused":
      console.warn(`[relayer] piece ${m.drawing}:${m.index} not placed on chain: ${m.why}${m.tx ? `, tx ${m.tx}` : ""}`);
      break;
    case "settled":
      console.info(`[relayer] settled bet ${m.betId}: hits ${m.hitMask}, misses ${m.missMask}, paid ${m.paid}, owed ${m.owed}, tx ${m.tx}`);
      break;
    case "account":
      console.info(`[relayer] account: balance ${m.balance}, session ${m.session ? `${m.session.key} until ${m.session.validUntil}, allowance ${m.session.allowance}` : "none"}`);
      break;
    case "error":
      if (m.why) console.warn(`[relayer] error: ${m.why}`);
      break;
  }
}
