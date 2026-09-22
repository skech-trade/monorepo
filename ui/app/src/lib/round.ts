"use client";

import { useEffect, useState } from "react";
import type { Pt } from "@skech/core/shape";
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
 * With no trader configured every call answers null and the round runs the
 * way it always has, against real prices with no position behind it. That is
 * what the tests and screenshots use, and it is the honest default: better a
 * round that plainly did not trade than one that pretends it did.
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
  filledAt?: number;
  filled: number;
  avgPrice?: number;
  pnl: number;
  status: "sending" | "acked" | "partial" | "filled" | "rejected" | "uncertain";
  via?: "ws" | "http";
  error?: string;
};

/** One position held between two turns, with its own id. */
export type VenueTrade = { id: string; dir: 1 | -1; size: number; status: "opening" | "open" | "closing" | "closed" | "failed"; entry?: number; exit?: number; pnl: number; openedAt?: number; closedAt?: number };

/** A piece of the drawn line, as the trader scheduled it. Absolute times. */
export type VenueSegment = { id: string; dir: 1 | -1; startAt: number; endAt: number; skipped: boolean };

export type VenueRound = {
  id: string;
  status: "running" | "closing" | "done";
  net: number | null;
  pnlReady: boolean;
  segments?: VenueSegment[];
  trades?: VenueTrade[];
  timing?: { requestedAt: number; readyAt?: number; openAckAt?: number; openFilledAt?: number; closeRequestedAt?: number; closeAckAt?: number; closedAt?: number };
  exit?: number;
  untracked?: boolean;
  bars?: import("./market").Candle[];
  fills?: {id:string;at:number;buy:boolean;price:number;size:number}[];
  pts: Pt[];
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
};

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
  const res = await fetch(`${URL_TRADER}/keys/${address}`).catch(() => null);
  const body = res?.ok ? ((await res.json().catch(() => null)) as { registered?: boolean; accountIndex?: number | null } | null) : null;
  return { registered: Boolean(body?.registered), accountIndex: body?.accountIndex ?? null };
}

/** Step one: the message the wallet has to sign, word for word. */
export async function prepareKey(address: string): Promise<{ messageToSign?: string; already?: boolean; error?: string }> {
  if (!hasTrader) return { error: "No trader configured." };
  const res = await fetch(`${URL_TRADER}/keys/prepare`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address }),
  }).catch(() => null);
  if (!res) return { error: "The trader did not answer." };
  return ((await res.json().catch(() => null)) as { messageToSign?: string; already?: boolean; error?: string } | null) ?? { error: "No answer." };
}

/** Step two: hand back the signature, and the key is theirs from then on. */
export async function registerKey(address: string, signature: string): Promise<{ ok?: boolean; accountIndex?: number; error?: string }> {
  if (!hasTrader) return { error: "No trader configured." };
  const res = await fetch(`${URL_TRADER}/keys/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address, signature }),
  }).catch(() => null);
  if (!res) return { error: "The trader did not answer." };
  return ((await res.json().catch(() => null)) as { ok?: boolean; accountIndex?: number; error?: string } | null) ?? { error: "No answer." };
}

/**
 * Which Lighter account the trader signs for.
 *
 * It holds one key for one account, so every round lands there whoever is
 * signed in. That is fine for testing and dishonest to hide: somebody
 * watching their own balance sit still while the chart moves is owed the
 * reason. The app compares this with the account behind their own wallet and
 * says when they are not the same.
 */
export function useTraderAccount(): number | null {
  const [account, setAccount] = useState<number | null>(null);
  useEffect(() => {
    if (!hasTrader) return;
    let live = true;
    fetch(`${URL_TRADER}/health`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => live && typeof d?.account === "number" && setAccount(d.account))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return account;
}

export type RoundSpec = {
  /** Whose account this trades. Their key signs it; their balance moves. */
  address: string;
  pts: Pt[];
  stake: number;
  leverage: number;
  seconds: number;
  exits: Exits;
};

/** Open a round on the venue. Answers as soon as it is open, not when it ends. */
export async function openRound(spec: RoundSpec): Promise<VenueRound | { error: string; needsKey?: boolean }> {
  if (!hasTrader) return { error: "No trader configured." };
  const res = await fetch(`${URL_TRADER}/rounds`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(spec),
  }).catch(() => null);
  if (!res) return { error: "The trader did not answer." };
  const body = (await res.json().catch(() => null)) as (VenueRound & { error?: string; needsKey?: boolean }) | null;
  if (!res.ok || !body || body.error) return { error: body?.error ?? "The trader turned that down.", needsKey: body?.needsKey };
  return body;
}

/**
 * Everything a trade needs, done while the line is still being drawn: the
 * trader subscribes to this account, reads its nonce and sets its leverage,
 * so pressing the button costs one round trip to the venue and nothing else.
 */
export async function prepareRound(address: string, leverage: number): Promise<{ ready?: boolean; needsKey?: boolean; latencyMs?: number; error?: string }> {
  if (!hasTrader) return { error: "No trader configured." };
  const res = await fetch(`${URL_TRADER}/rounds/prepare`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address, leverage }) }).catch(() => null);
  if (!res) return { error: "The trader did not answer." };
  return ((await res.json().catch(() => null)) as { ready?: boolean; needsKey?: boolean; latencyMs?: number; error?: string } | null) ?? { error: "No answer." };
}

/** A new line for a running round. The trader keeps the past and re-plans the rest. */
export async function editRound(id: string, pts: Pt[], seconds?: number): Promise<VenueRound | { error: string }> {
  const res = await fetch(`${URL_TRADER}/rounds/${id}/plan`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ pts, seconds }) }).catch(() => null);
  const body = res ? ((await res.json().catch(() => null)) as (VenueRound & { error?: string }) | null) : null;
  if (!res?.ok || !body || body.error) return { error: body?.error ?? "The trader did not take that change." };
  return body;
}

/** Cut a part of the line out of a running round, or put it back. */
export async function skipSegment(id: string, segmentId: string, skipped: boolean): Promise<VenueRound | { error: string }> {
  const res = await fetch(`${URL_TRADER}/rounds/${id}/segments/${segmentId}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ skipped }) }).catch(() => null);
  const body = res ? ((await res.json().catch(() => null)) as (VenueRound & { error?: string }) | null) : null;
  if (!res?.ok || !body || body.error) return { error: body?.error ?? "The trader did not take that change." };
  return body;
}

/** Out now, at the market. */
export async function closeRound(id: string): Promise<VenueRound | null> {
  if (!hasTrader) return null;
  const res = await fetch(`${URL_TRADER}/rounds/${id}/close`, { method: "POST" }).catch(() => null);
  return res?.ok ? ((await res.json().catch(() => null)) as VenueRound | null) : null;
}

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
    const events = new EventSource(`${URL_TRADER}/rounds/${id}/events`);
    const accept = (round: VenueRound) => {
      if(!live || round.id!==id)return;
      setGot({id,round});
      if(round.status==="done"){done=true;events.close();}
    };
    events.addEventListener("round",event=>{
      try{lastEvent=Date.now();accept(JSON.parse((event as MessageEvent).data));}catch{}
    });
    events.addEventListener("heartbeat",()=>{lastEvent=Date.now();});
    events.onerror=()=>{lastEvent=0;};
    let timer: ReturnType<typeof setTimeout> | null = null;
    const ask = async () => {
      if(!live || done)return;
      if(!lastEvent || Date.now()-lastEvent>25000){
        const res=await fetch(`${URL_TRADER}/rounds/${id}`).catch(()=>null);
        const round=res?.ok?await res.json().catch(()=>null):null;
        // A delayed fallback response must not overwrite a newer pushed update.
        if(round && (!lastEvent || Date.now()-lastEvent>25000))accept(round);
      }
      if(live && !done)timer=setTimeout(ask,1000);
    };
    void ask();
    return()=>{live=false;events.close();if(timer)clearTimeout(timer);};
  }, [id]);

  return got && got.id === id ? got.round : null;
}

/** Durable venue history. Never seed a new account with example trades. */
export function useVenueHistory(accountIndex:number|null) {
  const [history,setHistory]=useState<{account:number;rounds:VenueRound[]}|null>(null);
  useEffect(()=>{
    if(accountIndex===null||!hasTrader)return;
    let alive=true;
    /* Only this account's recent rounds. The trader tags the list, the browser
       revalidates it, and an unchanged list costs a 304 and no re-render. */
    let seen = "";
    const load=async()=>{try {const res=await fetch(`${URL_TRADER}/rounds?account=${accountIndex}&limit=50`);if(!res.ok)return;const text=await res.text();if(!alive||text===seen)return;seen=text;const data=JSON.parse(text);if(Array.isArray(data.rounds))setHistory({account:accountIndex,rounds:data.rounds});}catch{}};
    void load();const timer=setInterval(load,2000);return()=>{alive=false;clearInterval(timer);};
  },[accountIndex]);
  return history?.account===accountIndex?history.rounds:[];
}

export async function closeExistingPosition(address:string):Promise<VenueRound> {
  const res=await fetch(`${URL_TRADER}/positions/close`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({address})});
  const data=await res.json();if(!res.ok||data.error)throw Error(data.error??"Could not confirm the close");return data;
}
