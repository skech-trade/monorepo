"use client";

import { useEffect, useState } from "react";

/**
 * Who you are and what you are worth, from `services/api`.
 *
 * The name is ours, kept in Postgres against the wallet. The balance is the
 * venue's, read straight from Lighter, because two places claiming to know
 * what an account holds is one place too many.
 *
 * With no API configured everything answers empty and nothing breaks, which
 * is what the tests and screenshots use.
 */

const URL_API = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "");

export const hasApi = URL_API !== "";

export type Balance = {
  /** USDC on the perp account: what can be traded with. */
  collateral: number;
  available: number;
  /** Marked profit and loss on anything open. */
  unrealised: number;
  /** Collateral plus unrealised. What the account is actually worth. */
  equity: number;
  positions: number;
  /** Null when this wallet has never deposited, so has no account yet. */
  accountIndex: number | null;
};

export type Profile = {
  /** What they asked to be called, or null if they have not said. */
  name: string | null;
  balance: Balance | null;
  /** Whether we have finished asking, so the UI can wait rather than flicker. */
  ready: boolean;
  refresh: () => void;
};

const EMPTY: Profile = { name: null, balance: null, ready: true, refresh: () => undefined };

export function useProfile(address: string | null): Profile {
  const [name, setName] = useState<string | null>(null);
  const [balance, setBalance] = useState<Balance | null>(null);
  /** Which address the answers on hand belong to, so `ready` is derived rather than set. */
  const [answered, setAnswered] = useState<string | null>(null);
  const [token, setToken] = useState(0);

  useEffect(() => {
    if (!hasApi || !address) return;
    let live = true;
    const load = async () => {
      const [me, bal] = await Promise.all([
        fetch(`${URL_API}/me?address=${address}`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
        fetch(`${URL_API}/balance?address=${address}`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      ]);
      if (!live) return;
      setName((me as { name?: string | null } | null)?.name ?? null);
      setBalance((bal as Balance | null) ?? null);
      setAnswered(address);
    };
    void load();
    // The venue moves, so the balance is worth asking again now and then.
    const again = setInterval(load, 3000);
    // Something just moved money, so ask now rather than on the next tick.
    const changed = () => void load();
    window.addEventListener("skech-balance", changed);
    return () => {
      live = false;
      clearInterval(again);
      window.removeEventListener("skech-balance", changed);
    };
  }, [address, token]);

  if (!hasApi || !address) return EMPTY;
  const ready = answered === address;
  return {
    name: ready ? name : null,
    balance: ready ? balance : null,
    ready,
    refresh: () => setToken((n) => n + 1),
  };
}
