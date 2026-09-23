"use client";

import { useCallback, useEffect, useState } from "react";
import type { Pt } from "@/lib/sketch";

/**
 * The player behind a wallet: a claimed name, a buddy and the points their
 * predictions earn, from `services/api`.
 *
 * Claiming a name is one wallet signature. The API answers it with a session
 * token, kept in this browser per wallet, and every later call carries it.
 */

const API = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "");

export type Player = {
  username: string;
  buddy: "blue" | "mint" | "coral";
  points: number;
  level: number;
  nextLevelAt: number | null;
  achievements: string[];
  completed: number;
  dailyRemaining: number;
};

const tokenKey = (address: string) => `skech.player.${address.toLowerCase()}`;

function readToken(address: string | null): string | null {
  try {
    return address ? localStorage.getItem(tokenKey(address)) : null;
  } catch {
    return null;
  }
}

/** A call to the API's player routes: a GET without a body, a POST with one. Throws what the API said. */
async function request<T>(path: string, token: string | null, body?: unknown): Promise<T> {
  if (!API) throw Error("Player profiles need the API connection.");
  const res = await fetch(`${API}/social/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok || data === null) throw Object.assign(Error(data?.error ?? "Please try again."), { status: res.status });
  return data;
}

export function usePlayer(address: string | null, signMessage: (message: string) => Promise<string | null>) {
  /* Kept with the address it belongs to, so a different wallet never shows the last one's player. */
  const [state, setState] = useState<{ address: string; player: Player } | null>(null);
  const [loadedAddress, setLoadedAddress] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const player = state?.address === address ? state.player : null;

  const refresh = useCallback(async () => {
    if (!address) return;
    const token = readToken(address);
    if (!token) {
      setLoadedAddress(address);
      return;
    }
    try {
      setState({ address, player: await request<Player>("me", token) });
    } catch (error) {
      // A session the API no longer knows: forget it. Anything else keeps the player on hand.
      if ((error as { status?: number }).status === 401) {
        try {
          localStorage.removeItem(tokenKey(address));
        } catch {
          // Private mode. The token goes with the tab.
        }
        setState(null);
      }
    } finally {
      setLoadedAddress(address);
    }
  }, [address]);

  // Hydrate the account from its external session token, then subscribe to updates.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    const timer = setInterval(() => void refresh(), 10000);
    const sync = () => void refresh();
    window.addEventListener("skech-player", sync);
    return () => {
      clearInterval(timer);
      window.removeEventListener("skech-player", sync);
    };
  }, [refresh]);

  const claim = async (username: string) => {
    if (!address) {
      setNote("Sign in from the top bar to claim your player name.");
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      const challenge = await request<{ id: string; message: string }>("challenge", null, { address, username });
      const signature = await signMessage(challenge.message);
      if (!signature) throw Error("Signature cancelled. No username was claimed.");
      const result = await request<{ token: string; profile: Player }>("claim", null, { id: challenge.id, signature });
      try {
        localStorage.setItem(tokenKey(address), result.token);
      } catch {
        throw Error("Enable browser storage to keep your player signed in.");
      }
      setState({ address, player: result.profile });
      window.dispatchEvent(new Event("skech-player"));
      setNote("Your player is ready. Points are saved to your account.");
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const saveBuddy = async (buddy: Player["buddy"]) => {
    if (!address) return;
    setBusy(true);
    try {
      const updated = await request<Player>("buddy", readToken(address), { buddy });
      setState({ address, player: updated });
      window.dispatchEvent(new Event("skech-player"));
      return true;
    } catch (e) {
      setNote((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const startPrediction = async (pts: Pt[], seconds: number, market: string) => {
    if (!address || !player) return;
    try {
      await request("predictions", readToken(address), { pts, seconds, market });
      setNote("Prediction registered for points. Your original line is scored when its full window ends.");
      void refresh();
    } catch (e) {
      setNote(`Points: ${(e as Error).message}`);
    }
  };

  return { player, ready: !address || loadedAddress === address, busy, note, claim, saveBuddy, startPrediction };
}

export type PlayerState = ReturnType<typeof usePlayer>;
