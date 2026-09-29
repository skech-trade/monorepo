"use client";

import { useEffect, useRef, useState } from "react";
import type { Address, Hex } from "viem";
import { RELAYER_URL } from "./chain";

/**
 * The relayer: where the app sends what it draws, signed by the session key,
 * and hears back what the chain made of it. One socket, reopened when it
 * drops; every message is JSON with the chain's numbers as strings.
 */

export type Hello = {
  type: "hello";
  chainId: number;
  game: Address;
  iou: Address | null;
  usdc: Address | null;
  oracle: Address | null;
  market: { id: number; name: string };
  difficulty: number | null;
  lateMs: number;
  units: string[] | null;
  config: { minPerDot: string; maxPerDot: string; maxPieceStake: string; feeBps: number; profitFeeBps: number } | null;
};
export type Account = { player: Address; balance: string; session: { key: Address; x: Hex; y: Hex; validUntil: string; allowance: string }; owed: string; nonce?: string | null };
export type PlacedMsg = { type: "placed"; betId: Hex; player: Address; openAt: string; staked: string; fee: string; refunded: string; sections: { second: number; lo: string; hi: string; stake: string; rung: number }[]; tx: Hex };
export type RefusedMsg = { type: "refused"; betId: Hex; player: Address; why: string; tx?: Hex };
export type SettledMsg = { type: "settled"; betId: Hex; player: Address; hitMask: number; missMask: number; paid: string; owed: string; tx: Hex };
export type AckMsg = { type: "ack"; ok: boolean; betId?: Hex; why?: string; drawing?: string; index?: number };
export type Done = { ok: boolean; why?: string; tx?: Hex; amount?: string };
export type Incoming =
  | Hello
  | ({ type: "account" } & Account)
  | PlacedMsg
  | RefusedMsg
  | SettledMsg
  | AckMsg
  | { type: "owed"; value: string }
  | ({ type: "session-set" } & Done)
  | ({ type: "deposited" } & Done)
  | ({ type: "withdrawn" } & Done)
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
  player: Address | null = null;

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

  /** Follow one player's account and bets. */
  watch(player: Address | null) {
    this.player = player;
    if (player) this.send({ type: "watch", player });
  }

  private connect() {
    if (this.stopped) return;
    const sock = new WebSocket(this.url);
    this.ws = sock;
    sock.onopen = () => {
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
      this.emit(m);
    };
    sock.onclose = () => {
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

/** One relayer for the page, following `player`. */
export function useRelayer(player: Address | null, enabled: boolean) {
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
  // An account is only the player's while they are the player.
  const own = player && account && account.player.toLowerCase() === player.toLowerCase() ? account : null;
  return { client, hello, account: own, connected };
}
