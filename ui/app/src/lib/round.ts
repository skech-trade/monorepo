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

export type VenueRound = {
  id: string;
  status: "running" | "done";
  outcome: "time" | "stop" | "target" | "failed" | null;
  entry: number;
  size: number;
  unrealised: number;
  realised: number;
  orders: { at: number; want: number; hash: string }[];
  problem: string | null;
};

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
  pts: Pt[];
  stake: number;
  leverage: number;
  seconds: number;
  exits: Exits;
};

/** Open a round on the venue. Answers as soon as it is open, not when it ends. */
export async function openRound(spec: RoundSpec): Promise<VenueRound | { error: string }> {
  if (!hasTrader) return { error: "No trader configured." };
  const res = await fetch(`${URL_TRADER}/rounds`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(spec),
  }).catch(() => null);
  if (!res) return { error: "The trader did not answer." };
  const body = (await res.json().catch(() => null)) as (VenueRound & { error?: string }) | null;
  if (!res.ok || !body || body.error) return { error: body?.error ?? "The trader turned that down." };
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
 * Every two seconds, because the position is the venue's and it changes when
 * the venue says so, not when a timer here says it should have. Stops asking
 * once the round is done, so a settled screen is not still polling.
 */
export function useVenueRound(id: string | null): VenueRound | null {
  /* Kept with the id it belongs to, so switching rounds shows nothing rather
     than the last one's figures, and no effect has to clear it. */
  const [got, setGot] = useState<{ id: string; round: VenueRound } | null>(null);

  useEffect(() => {
    if (!hasTrader || !id) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const ask = async () => {
      const res = await fetch(`${URL_TRADER}/rounds/${id}`).catch(() => null);
      const round = res?.ok ? ((await res.json().catch(() => null)) as VenueRound | null) : null;
      if (!live) return;
      if (round) setGot({ id, round });
      if (round?.status !== "done") timer = setTimeout(ask, 2000);
    };
    void ask();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [id]);

  return got && got.id === id ? got.round : null;
}
