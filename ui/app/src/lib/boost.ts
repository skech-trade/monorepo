"use client";

import { useCallback, useEffect, useState } from "react";
import type { Pt } from "@skech/core/shape";
import type { VenueRound } from "./round";

/**
 * Wild, from the page.
 *
 * skech adds five times what you put in, the round trades the lot, and it
 * ends itself once 80% of what you put in is gone. skech keeps 30% of a win
 * and 1% of a loss. The money for it has to sit on skech's side while the
 * round runs, and none of that is the reader's business: placing a Wild round
 * moves what it needs from their Lighter account, signed by the embedded
 * wallet without a prompt, and whatever is left goes back when they pick
 * another pace, or by itself once they stop. The page shows one balance.
 * Everything here is the trader's to decide: this file only asks.
 */

const URL_TRADER = (process.env.NEXT_PUBLIC_TRADER_URL ?? "").replace(/\/$/, "");

export type BoostRules = {
  multiple: number;
  closeAt: number;
  cut: number;
  lossFee: number;
  leverage: number;
  stakeMin: number;
  stakeMax: number;
  markets: string[];
  /** Margin the trader leaves free in a lane; the round trades the rest. */
  headroom: number;
};

export type BoostRoundView = {
  id: string;
  roundId: string | null;
  market: string;
  stake: number;
  boost: number;
  status: "reserved" | "funding" | "running" | "settling" | "done" | "refunded";
  problem: string | null;
  back: number | null;
  fee: number | null;
  cut: number | null;
  at: number;
};

export type BoostStatus = {
  enabled: boolean;
  why: string | null;
  balance: number;
  open: BoostRoundView | null;
  recent: BoostRoundView[];
  rules: BoostRules;
  lanes: { free: number; total: number };
  /** How much more boost skech can put out right now. */
  room: number;
};

/** A boosted round's terms and result, as the trader keeps them on the round. */
export type BoostTag = {
  id: string;
  owner: string;
  accountIndex: number;
  stake: number;
  boost: number;
  closeAt: number;
  cut: number;
  lossFee: number;
  status: "running" | "settling" | "done" | "refunded";
  settlement?: { equity: number; back: number; fee: number; cut: number; gap: number };
  problem?: string | null;
};

/** What a boosted stake trades like, in dollars. */
export const boostedSize = (stake: number, rules: BoostRules) => stake * (1 + rules.multiple) * (1 - rules.headroom) * rules.leverage;

/**
 * What the user has made so far on a boosted round, before the round is
 * booked: 70% of a gain, all of a loss, never more than the stake. The 1% on
 * a loss is only taken at the end.
 */
export const userShare = (net: number, tag: Pick<BoostTag, "stake" | "cut">) => (net > 0 ? net * (1 - tag.cut) : Math.max(net, -tag.stake));

export const hasBoost = URL_TRADER !== "";

type Failure = { error: string; needsKey?: boolean };

async function post<T>(path: string, body: unknown): Promise<T | Failure> {
  const res = await fetch(`${URL_TRADER}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
  if (!res) return { error: "The trader did not answer." };
  const data = (await res.json().catch(() => null)) as (T & { error?: string; needsKey?: boolean }) | null;
  if (!res.ok || !data || data.error) return { error: data?.error ?? "That did not go through.", needsKey: data?.needsKey };
  return data;
}

/** Ask every Boost panel on the page to read again, after money moved. */
export const refreshBoost = () => window.dispatchEvent(new Event("skech-boost"));

/** This wallet's Boost: balance, rules, and a round if one is running. Re-read every few seconds and after anything moves money. */
export function useBoost(address: string | null, market: string): { status: BoostStatus | null; unavailable: string | null; refresh: () => void } {
  const [got, setGot] = useState<{ key: string; status: BoostStatus | null; unavailable: string | null } | null>(null);
  const key = `${address}|${market}`;
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    if (!address || !hasBoost) return;
    let alive = true;
    const load = async () => {
      const res = await fetch(`${URL_TRADER}/boost/status?address=${address}&market=${market}`).catch(() => null);
      const data = res ? ((await res.json().catch(() => null)) as (BoostStatus & { error?: string }) | null) : null;
      if (!alive) return;
      if (!res || !data) return setGot({ key, status: null, unavailable: "The trader did not answer." });
      if (!res.ok || data.error) return setGot({ key, status: null, unavailable: data.error ?? "Boost is unavailable." });
      setGot({ key, status: data, unavailable: null });
    };
    void load();
    const timer = setInterval(load, 5000);
    const again = () => void load();
    window.addEventListener("skech-boost", again);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener("skech-boost", again);
    };
  }, [address, market, key, tick]);

  return { status: got?.key === key ? got.status : null, unavailable: got?.key === key ? got.unavailable : null, refresh };
}

export function openBoostRound(spec: { address: string; market: string; pts: Pt[]; stake: number; seconds: number }) {
  return post<VenueRound>("/boost/rounds", spec);
}

function prepareDeposit(address: string, amount: number) {
  return post<{ id: string; fee: number; messageToSign: string }>("/boost/deposit/prepare", { address, amount });
}

function confirmDeposit(address: string, id: string, signature: string) {
  return post<{ balance: number }>("/boost/deposit/confirm", { address, id, signature });
}

/**
 * Make sure there is `stake` on skech's side for a Wild round, moving the
 * shortfall from the wallet's Lighter account. One silent signature; answers
 * once the money has arrived. Lighter's transfer fee comes from the Lighter
 * account on top. Throws with `needsKey` when the wallet has no trading key.
 */
export async function fundWild(address: string, stake: number, held: number, signMessage: (message: string) => Promise<string | null>): Promise<number> {
  // Cents, rounded up, and Lighter will not move less than a dollar.
  const short = Math.max(1, Math.ceil((stake - held) * 100) / 100);
  if (held >= stake) return held;
  const prep = await prepareDeposit(address, short);
  if ("error" in prep) throw Object.assign(Error(prep.error), { needsKey: prep.needsKey === true });
  const signature = await signMessage(prep.messageToSign);
  if (!signature) throw Error("Signature cancelled. No trade was placed.");
  const done = await confirmDeposit(address, prep.id, signature);
  if ("error" in done) throw Error(done.error);
  refreshBoost();
  return done.balance;
}

/** Send whatever is on skech's side back to the wallet's own Lighter account. Nothing to send is not a failure. */
export async function returnWild(address: string) {
  const done = await post<{ sent: number; fee: number; balance: number }>("/boost/withdraw", { address, all: true });
  refreshBoost();
  window.dispatchEvent(new Event("skech-balance"));
  return done;
}
