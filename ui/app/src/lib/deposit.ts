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
        .catch(() => undefined);
    }, 350);
    return () => {
      live = false;
      clearTimeout(wait);
    };
  }, [asking, address, chain, token, smallest]);

  const settled = answer?.key === asking;
  return { quote: settled ? answer.quote : null, busy: Boolean(asking) && !settled };
}
