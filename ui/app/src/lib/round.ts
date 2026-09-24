"use client";

import { useEffect, useState } from "react";
import type { Pt } from "@skech/core/shape";
import type { BoostTag } from "./boost";
import type { Candle } from "./market";
import type { Exits } from "./sketch";

/**
 * Rounds that actually happen.
 *
 * The page sends the points it drew and nothing else. What the line means,
 * which way the position faces at each moment and what size it is are all
 * worked out by `services/trader`, from `@skech/core`, the same code this
 * page quotes with. A page that decided its own orders could claim it drew
 * anything.
 *
 * With no trader configured nothing trades: every call answers with an error
 * or nothing, and the screen says trading is unavailable. That is the honest
 * default: better a round that plainly did not trade than one that pretends
 * it did.
 */

const URL_TRADER = (process.env.NEXT_PUBLIC_TRADER_URL ?? "").replace(/\/$/, "");

export const hasTrader = URL_TRADER !== "";

/** One order on the venue. Its times are the trader's clock, the same one the round's start is on. */
export type VenueOrder = {
  id: string;
  tradeId: string;
  kind: "open" | "close";
  side: "buy" | "sell";
  size: number;
  dueAt: number;
  requestedAt: number;
  sentAt?: number;
  ackAt?: number;
  /** The chart's price when the venue took it, stamped by the trader. What P&L on testnet is priced at. */
  chartAt?: number;
  filledAt?: number;
  filled: number;
  avgPrice?: number;
  pnl: number;
  status: "sending" | "acked" | "partial" | "filled" | "rejected" | "uncertain";
  via?: "ws" | "http";
  error?: string;
};

/** One position held between two turns, with its own id. */
export type VenueTrade = {
  id: string;
  dir: 1 | -1;
  size: number;
  status: "opening" | "open" | "closing" | "closed" | "failed";
  entry?: number;
  exit?: number;
  pnl: number;
  openedAt?: number;
  closedAt?: number;
};

/** A piece of the drawn line, as the trader scheduled it. Absolute times. */
export type VenueSegment = { id: string; dir: 1 | -1; startAt: number; endAt: number; skipped: boolean };

export type VenueRound = {
  id: string;
  status: "running" | "closing" | "done";
  net: number | null;
  pnlReady: boolean;
  segments?: VenueSegment[];
  trades?: VenueTrade[];
  timing?: {
    requestedAt: number;
    readyAt?: number;
    openAckAt?: number;
    openFilledAt?: number;
    closeRequestedAt?: number;
    closeAckAt?: number;
    closedAt?: number;
  };
  exit?: number;
  untracked?: boolean;
  bars?: Candle[];
  fills?: { id: string; at: number; buy: boolean; price: number; size: number }[];
  pts: Pt[];
  /** BTC or ETH. Rounds from before a second market have none, and are Bitcoin. */
  market?: string;
  stake: number;
  leverage: number;
  seconds: number;
  startedAt: number;
  outcome: "time" | "stop" | "target" | "failed" | null;
  entry: number;
  chartEntry?: number;
  /** The Lighter account it traded on, which is the drawer's own. */
  accountIndex: number;
  size: number;
  unrealised: number;
  realised: number;
  orders: VenueOrder[];
  problem: string | null;
  /** skech's money is in this round: its terms, and once settled, what came back. */
  boost?: BoostTag;
  /** The loss exit resting on the venue, when there is one. */
  guard?: { status: "placing" | "resting" | "fired" | "cancelled" | "failed"; trigger: number; dir: 1 | -1 } | null;
};

type Failure = { error: string };

const NO_ANSWER = "The trader did not answer.";

/** A request to the trader, or null when it could not be reached. A body goes as JSON; none sends none. */
function send(path: string, method?: string, body?: unknown): Promise<Response | null> {
  const init: RequestInit | undefined =
    method === undefined
      ? undefined
      : body === undefined
        ? { method }
        : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
  return fetch(`${URL_TRADER}${path}`, init).catch(() => null);
}

/** The response's JSON, or null when it has none worth reading. */
async function json<T>(res: Response): Promise<T | null> {
  return (await res.json().catch(() => null)) as T | null;
}

/** A step whose answer is read whatever the status: the trader puts its refusal in the body. */
async function step<T extends { error?: string }>(path: string, body: unknown): Promise<T | Failure> {
  const res = await send(path, "POST", body);
  if (!res) return { error: NO_ANSWER };
  return (await json<T>(res)) ?? { error: "No answer." };
}

/** A call that answers with the round, or says why it did not. */
async function roundFrom(res: Response | null, refused: string): Promise<VenueRound | (Failure & { needsKey?: boolean })> {
  const body = res ? await json<VenueRound & { error?: string; needsKey?: boolean }>(res) : null;
  if (!res?.ok || !body || body.error) return { error: body?.error ?? refused, needsKey: body?.needsKey };
  return body;
}

/**
 * Whether this wallet can trade its own Lighter account yet.
 *
 * It can once it has registered a trading key against it, which takes one
 * signature from the wallet and lasts. Until then a round has nothing to sign
 * with, and trading somebody else's account instead would be worse than not
 * trading at all.
 */
export async function keyFor(address: string): Promise<{ registered: boolean; accountIndex: number | null }> {
  if (!hasTrader) return { registered: false, accountIndex: null };
  const res = await send(`/keys/${address}`);
  const body = res?.ok ? await json<{ registered?: boolean; accountIndex?: number | null }>(res) : null;
  return { registered: Boolean(body?.registered), accountIndex: body?.accountIndex ?? null };
}

/** Step one: the message the wallet has to sign, word for word. */
export async function prepareKey(address: string): Promise<{ messageToSign?: string; already?: boolean; error?: string }> {
  if (!hasTrader) return { error: "No trader configured." };
  return step("/keys/prepare", { address });
}

/** Step two: hand back the signature, and the key is theirs from then on. */
export async function registerKey(address: string, signature: string): Promise<{ ok?: boolean; accountIndex?: number; error?: string }> {
  if (!hasTrader) return { error: "No trader configured." };
  return step("/keys/register", { address, signature });
}

export type RoundSpec = {
  /** Whose account this trades. Their key signs it; their balance moves. */
  address: string;
  /** Which market it trades: BTC or ETH. */
  market: string;
  pts: Pt[];
  stake: number;
  leverage: number;
  seconds: number;
  exits: Exits;
};

/** Open a round on the venue. Answers as soon as it is open, not when it ends. */
export async function openRound(spec: RoundSpec): Promise<VenueRound | { error: string; needsKey?: boolean }> {
  if (!hasTrader) return { error: "No trader configured." };
  const res = await send("/rounds", "POST", spec);
  if (!res) return { error: NO_ANSWER };
  return roundFrom(res, "The trader turned that down.");
}

/**
 * Everything a trade needs, done while the line is still being drawn: the
 * trader subscribes to this account, reads its nonce and sets its leverage,
 * so pressing the button costs one round trip to the venue and nothing else.
 */
export async function prepareRound(address: string, leverage: number, market: string): Promise<{ ready?: boolean; needsKey?: boolean; latencyMs?: number; error?: string }> {
  if (!hasTrader) return { error: "No trader configured." };
  return step("/rounds/prepare", { address, leverage, market });
}

/** A new line for a running round. The trader keeps the past and re-plans the rest. */
export async function editRound(id: string, pts: Pt[], seconds?: number): Promise<VenueRound | Failure> {
  return roundFrom(await send(`/rounds/${id}/plan`, "PUT", { pts, seconds }), "The trader did not take that change.");
}

/** Cut a part of the line out of a running round, or put it back. */
export async function skipSegment(id: string, segmentId: string, skipped: boolean): Promise<VenueRound | Failure> {
  return roundFrom(await send(`/rounds/${id}/segments/${segmentId}`, "POST", { skipped }), "The trader did not take that change.");
}

/** Out now, at the market. */
export async function closeRound(id: string): Promise<VenueRound | null> {
  if (!hasTrader) return null;
  const res = await send(`/rounds/${id}/close`, "POST");
  return res?.ok ? json<VenueRound>(res) : null;
}

/**
 * Close a position the account holds with no round behind it, such as one
 * left over from before a refresh. Throws, because the caller has to say the
 * position may still be open.
 */
export async function closeExistingPosition(address: string, market: string): Promise<VenueRound> {
  const res = await send("/positions/close", "POST", { address, market });
  if (!res) throw Error(NO_ANSWER);
  const data = await json<VenueRound & { error?: string }>(res);
  if (!res.ok || !data || data.error) throw Error(data?.error ?? "Could not confirm the close");
  return data;
}

/** How long the event stream may go quiet before the page asks for the round itself. */
const STREAM_STALE_MS = 25_000;

/**
 * Follow a round while it runs.
 *
 * The backend pushes snapshots and changes over server-sent events.
 * REST polling is only a fallback when that stream is unavailable or stale.
 * Neither transport turns an order acknowledgement into a confirmed fill.
 */
export function useVenueRound(id: string | null): VenueRound | null {
  /* Kept with the id it belongs to, so switching rounds shows nothing rather
     than the last one's figures, and no effect has to clear it. */
  const [got, setGot] = useState<{ id: string; round: VenueRound } | null>(null);

  useEffect(() => {
    if (!hasTrader || !id) return;
    let live = true;
    let done = false;
    let lastEvent = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const stale = () => !lastEvent || Date.now() - lastEvent > STREAM_STALE_MS;

    const events = new EventSource(`${URL_TRADER}/rounds/${id}/events`);
    const accept = (round: VenueRound) => {
      if (!live || round.id !== id) return;
      setGot({ id, round });
      // A boosted round is settled a few seconds after it ends; keep listening until what came back is known.
      const settled = !round.boost || round.boost.status === "done" || round.boost.status === "refunded";
      if (round.status === "done" && settled) {
        done = true;
        events.close();
      }
    };
    events.addEventListener("round", (event) => {
      lastEvent = Date.now();
      try {
        accept(JSON.parse((event as MessageEvent).data));
      } catch {
        // A malformed snapshot is dropped; the next one, or the fallback, replaces it.
      }
    });
    events.addEventListener("heartbeat", () => {
      lastEvent = Date.now();
    });
    events.onerror = () => {
      lastEvent = 0;
    };

    const ask = async () => {
      if (!live || done) return;
      if (stale()) {
        const res = await send(`/rounds/${id}`);
        const round = res?.ok ? await json<VenueRound>(res) : null;
        // A delayed fallback response must not overwrite a newer pushed update.
        if (round && stale()) accept(round);
      }
      if (live && !done) timer = setTimeout(ask, 1000);
    };
    void ask();

    return () => {
      live = false;
      events.close();
      if (timer) clearTimeout(timer);
    };
  }, [id]);

  return got && got.id === id ? got.round : null;
}

/** Durable venue history. Never seed a new account with example trades. */
export function useVenueHistory(accountIndex: number | null): VenueRound[] {
  const [history, setHistory] = useState<{ account: number; rounds: VenueRound[] } | null>(null);

  useEffect(() => {
    if (accountIndex === null || !hasTrader) return;
    let alive = true;
    /* Only this account's recent rounds. The trader tags the list, the browser
       revalidates it, and an unchanged list costs a 304 and no re-render. */
    let seen = "";
    const load = async () => {
      try {
        const res = await fetch(`${URL_TRADER}/rounds?account=${accountIndex}&limit=50`);
        if (!res.ok) return;
        const text = await res.text();
        if (!alive || text === seen) return;
        seen = text;
        const data = JSON.parse(text) as { rounds?: unknown };
        if (Array.isArray(data.rounds)) setHistory({ account: accountIndex, rounds: data.rounds as VenueRound[] });
      } catch {
        // Offline or mid-deploy: keep the last list and try again on the next tick.
      }
    };
    void load();
    const timer = setInterval(load, 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [accountIndex]);

  return history?.account === accountIndex ? history.rounds : [];
}
