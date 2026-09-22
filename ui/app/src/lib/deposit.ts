"use client";

import type { SendEvmTransactionWithEndUserAccountBodyNetwork } from "@coinbase/cdp-core";
import { useEffect, useState } from "react";

/** Adding money, through `services/api`. Nothing is signed here. */

const URL_API = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "");

/** The network name is CDP's own, so a chain we list is a chain the wallet can sign on. */
export type Network = SendEvmTransactionWithEndUserAccountBodyNetwork;

export type Chain = { id: number; name: string; network: Network; nativeSymbol: string; usdc: string };

export type DepositQuote = {
  inAmount: string;
  inSymbol: string;
  outAmount: string;
  outSymbol: string;
  /** Negative is what it costs. */
  impactUsd: number;
  seconds: number;
  intentAddress: string;
  transactions: { to: string; data: string; value: string; chainId: number }[];
};

export const NATIVE = "0x0000000000000000000000000000000000000000";

/** A chain a plain USDC transfer to the deposit address is watched on. */
export type SendTo = { id: number; name: string };

/** What comes back when there is nowhere to deposit, which is testnet. */
export type NoDeposits = { canDeposit: false; network: "testnet"; reason: string; canFaucet?: boolean; amount?: number };

export async function askFaucet(address: string): Promise<{ ok: true; amount: number } | { ok: false; reason: string }> {
  if (!URL_API) return { ok: false, reason: "No API configured, so there is nothing to ask." };
  const res = await fetch(`${URL_API}/faucet`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address }) }).catch(() => null);
  if (!res) return { ok: false, reason: "The faucet did not answer. Try again in a moment." };
  const body = (await res.json().catch(() => null)) as { ok?: boolean; amount?: number; reason?: string; error?: string } | null;
  if (res.ok && body?.ok) return { ok: true, amount: body.amount ?? 0 };
  return { ok: false, reason: body?.reason ?? body?.error ?? "The faucet turned that down." };
}

export type DepositAddress = {
  canDeposit?: true;
  address: string;
  chains: SendTo[];
  asset: string;
  minimum: number;
  /** Which Lighter this address belongs to. Real money only survives on one of them. */
  network: "mainnet" | "testnet";
};

/**
 * The one address that credits this wallet's Lighter account. Unchanging, so
 * it is fetched once and kept.
 */
export function useDepositAddress(address: string | null) {
  const [result, setResult] = useState<{owner: string; found: DepositAddress | NoDeposits | null; error: string | null} | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!URL_API || !address) return;
    let live = true;
    fetch(`${URL_API}/deposit/address?address=${encodeURIComponent(address)}`, {signal: AbortSignal.timeout(15000)})
      .then(async r => {
        if (!r.ok) throw Error("Deposit details are unavailable. Please try again.");
        const got = await r.json();
        if (got?.canDeposit !== false && !(typeof got?.address === "string" && Array.isArray(got.chains) && ["mainnet","testnet"].includes(got.network))) throw Error("Deposit details are unavailable. Please try again.");
        if (live) setResult({owner: address, found: got, error: null});
      })
      .catch(() => {if(live) setResult({owner: address, found: null, error: "Couldn’t load deposit details. Check your connection and try again."});});
    return () => { live = false; };
  }, [address, attempt]);
  const current = result?.owner === address ? result : null;
  return {
    found: current?.found ?? null,
    error: !address ? "Sign in to see your funding options." : !URL_API ? "Funding is unavailable right now." : current?.error ?? null,
    retry: () => {setResult(null);setAttempt(n => n+1);},
  };
}

export function useDepositChains(): Chain[] {
  const [chains, setChains] = useState<Chain[]>([]);
  useEffect(() => {
    if (!URL_API) return;
    let live = true;
    fetch(`${URL_API}/deposit/chains`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => live && setChains((d as { chains?: Chain[] } | null)?.chains ?? []))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return chains;
}

/**
 * What a deposit would do, priced before anything is signed.
 *
 * Asked again a moment after the reader stops typing, because a route is
 * priced live and quoting on every keystroke would be a request per digit.
 */
export function useDepositQuote(address: string | null, chain: Chain | null, native: boolean, smallest: string | null) {
  /** The answer, and what it is an answer to, so `busy` is derived. */
  const [answer, setAnswer] = useState<{ key: string; quote: DepositQuote | null } | null>(null);
  const token = chain ? (native ? NATIVE : chain.usdc) : null;
  const asking = address && chain && token && smallest ? `${address}:${chain.id}:${token}:${smallest}` : null;

  useEffect(() => {
    if (!URL_API || !asking || !address || !chain || !token || !smallest) return;
    let live = true;
    // A route is priced live, so asking on every keystroke would be a request
    // per digit. Wait until the typing stops.
    const wait = setTimeout(() => {
      fetch(`${URL_API}/deposit/quote?address=${address}&fromChain=${chain.id}&token=${token}&amount=${smallest}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (!live) return;
          const quote = (d as DepositQuote | null)?.transactions ? (d as DepositQuote) : null;
          setAnswer({ key: asking, quote });
        })
        .catch(() => {if(live) setAnswer({key:asking,quote:null});});
    }, 350);
    return () => {
      live = false;
      clearTimeout(wait);
    };
  }, [asking, address, chain, token, smallest]);

  const settled = answer?.key === asking;
  return { quote: settled ? answer.quote : null, busy: Boolean(asking) && !settled };
}
