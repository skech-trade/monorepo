"use client";

import { useCallback, useEffect, useState } from "react";

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

/**
 * Whether this wallet has already been asked for a name on this browser.
 *
 * The prompt used to come back on every visit, because with no name saved
 * there was nothing to say it had been asked, and a skip is an answer too.
 * Kept per wallet, so a different person on the same browser is still asked.
 */
const ASKED = "skech:named";

function alreadyAsked(address: string): boolean {
  try {
    return (JSON.parse(localStorage.getItem(ASKED) ?? "[]") as string[]).includes(address);
  } catch {
    return false;
  }
}

export function markAsked(address: string) {
  try {
    const all = new Set(JSON.parse(localStorage.getItem(ASKED) ?? "[]") as string[]);
    all.add(address);
    localStorage.setItem(ASKED, JSON.stringify([...all]));
  } catch {
    // Private mode. It will ask once more next time, which is survivable.
  }
}

export type Profile = {
  /** What they asked to be called, or null if they have not said. */
  name: string | null;
  balance: Balance | null;
  /** Whether we have finished asking, so the UI can wait rather than flicker. */
  ready: boolean;
  /** Whether to ask for a name: signed in, nothing saved, and not asked before. */
  needsName: boolean;
  setName: (name: string) => Promise<string | null>;
  refresh: () => void;
};

const EMPTY: Profile = { name: null, balance: null, ready: true, needsName: false, setName: async () => null, refresh: () => undefined };

export function useProfile(address: string | null): Profile {
  const [name, setNameState] = useState<string | null>(null);
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
      setNameState((me as { name?: string | null } | null)?.name ?? null);
      setBalance((bal as Balance | null) ?? null);
      setAnswered(address);
    };
    void load();
    // The venue moves, so the balance is worth asking again now and then.
    const again = setInterval(load, 3000);
    const changed=()=>void load();
    window.addEventListener("skech-balance",changed);
    return () => {
      live = false;
      clearInterval(again);
      window.removeEventListener("skech-balance",changed);
    };
  }, [address, token]);

  const setName = useCallback(
    async (next: string) => {
      if (!hasApi || !address) return null;
      const res = await fetch(`${URL_API}/me/name`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address, name: next }),
      }).catch(() => null);
      if (!res?.ok) return null;
      const { name: saved } = (await res.json()) as { name: string };
      setNameState(saved);
      markAsked(address);
      return saved;
    },
    [address],
  );

  if (!hasApi || !address) return EMPTY;
  const ready = answered === address;
  return { name: ready ? name : null, balance: ready ? balance : null, ready, needsName: ready && !name && !alreadyAsked(address), setName, refresh: () => setToken((n) => n + 1) };
}
