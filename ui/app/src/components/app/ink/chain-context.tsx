"use client";

import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { reportError, track } from "@/lib/analytics";
import { type Address, bytesToHex, type Hex } from "viem";
import { RECEIVE_WITH_AUTHORIZATION_TYPES, TYPES } from "@skech/core/chain";
import { useAccount } from "@/components/app/auth";
import { domain, gameNonce, onChain, GAME, usdcBalance, usdcDomain } from "@/lib/chain";
import { type Account, type Hello, type Incoming, type RelayerClient, useRelayer } from "@/lib/relayer";
import { canHoldSession, forgetSessionKey, sessionKey, type SessionKey } from "@/lib/session";

/**
 * Real money, when there is a game on chain and someone signed in: the
 * relayer, the player's account on the game, and the session key that signs
 * their ink. Everything a wallet has to sign goes through here, and there is
 * little of it: a session once, a permit per deposit, a withdrawal.
 *
 * Without a game configured, or signed out, `real` is false and the game
 * plays for practice money as it always has.
 */

export type Chain = {
  /** Playing for real: on chain, signed in, connected. */
  real: boolean;
  player: Address | null;
  client: RelayerClient;
  hello: Hello | null;
  account: Account | null;
  connected: boolean;
  /** The browser's session key, once it exists. */
  key: SessionKey | null;
  /** Whether the key on chain is this browser's, and still good for an hour. */
  sessionOk: boolean;
  /** Register this browser's key, with one signature from the wallet. */
  enableSession: () => Promise<string | null>;
  registering: boolean;
  /** USDC in, on an EIP-3009 authorization: one signature, no allowance. */
  deposit: (usdc: number) => Promise<string | null>;
  /** USDC out, to `to`, on a signature. */
  /** Send `usdc` from the balance to `to`: the transaction on success, or why not, in the relayer's words. */
  withdraw: (usdc: number, to: Address) => Promise<{ tx: string } | { why: string }>;
  /** USDC sitting in the wallet on its way in, as last read; null before the first read. */
  wallet: number | null;
  /** What is being moved into the balance right now, if anything. */
  adding: number | null;
  /** The last deposit that landed this visit: how much, and when. The deposit sheet says so. */
  landed: { amount: number; at: number } | null;
  /** The wallet's own USDC, read when asked. */
  walletUsdc: () => Promise<bigint>;
  /** What the app owes the player's own reckoning: the balance the relayer last said, in USDC, moved by what has happened since. */
  balance: number;
  /** Move the local balance by `usdc` until the relayer says otherwise. */
  nudge: (usdc: number) => void;
  /** Take the relayer's last word as the balance, dropping what was counted since: for when nothing is in flight. */
  resync: () => void;
};

const Ctx = createContext<Chain | null>(null);

const SESSION_DAYS = 7;
/** How much a session may stake in all before it must be registered again: $100,000. */
const SESSION_ALLOWANCE = 100_000_000_000n;
const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 300);
/** How often the wallet is looked at for USDC to move in, and how long to leave it after a move fails. */
const SWEEP_MS = 4000;
/** The least USDC moved in at once, in dollars: under it, a deposit costs more gas than it is worth. */
export const MIN_DEPOSIT = 1;
const SWEEP_BACKOFF_MS = 30_000;

export function ChainProvider({ children }: { children: ReactNode }) {
  const me = useAccount();
  const player = (onChain && me.signedIn ? me.address : null) as Address | null;
  const { client, hello, account, connected } = useRelayer(player, onChain);
  const [key, setKey] = useState<SessionKey | null>(null);
  const [registering, setRegistering] = useState(false);
  /** What has happened since the relayer last said the balance, against that word: forgotten when it speaks again. */
  const [moved, setMoved] = useState<{ said: string | null; by: number }>({ said: null, by: 0 });
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!onChain || !canHoldSession()) return;
    let live = true;
    void sessionKey().then((k) => live && setKey(k), () => undefined);
    return () => {
      live = false;
    };
  }, []);
  /*
    Signing out throws the browser's key away, from storage and from this page: the session it was registered
    for can sign nothing more here, and whoever signs in next registers a key of their own.
  */
  const wasSignedIn = useRef(false);
  useEffect(() => {
    if (me.signedIn) {
      wasSignedIn.current = true;
      return;
    }
    if (!wasSignedIn.current) return;
    wasSignedIn.current = false;
    setKey(null);
    if (canHoldSession()) void forgetSessionKey().catch(() => undefined);
  }, [me.signedIn]);

  // The relayer's word on the balance is the balance; between its words, what we know moves it.
  const said = account?.balance ?? null;
  const balance = Math.round(((said ? Number(said) / 1e6 : 0) + (moved.said === said ? moved.by : 0)) * 1e6) / 1e6;
  const nudge = useCallback((usdc: number) => setMoved((m) => ({ said, by: (m.said === said ? m.by : 0) + usdc })), [said]);
  // Nothing in flight: the relayer's word is the whole of it, and what the app counted since is let go, even
  // when the word is the same number (keyed on the number alone, a drift outlived every word that repeated it).
  const resync = useCallback(() => setMoved({ said: null, by: 0 }), []);
  // The relayer's latest word, for async code that must know whether it has spoken since it started.
  const saidRef = useRef(said);
  const nudgeRef = useRef(nudge);
  const accountRef = useRef(account);
  useEffect(() => {
    saidRef.current = said;
    nudgeRef.current = nudge;
    accountRef.current = account;
  }, [said, nudge, account]);
  // The game nonce as the relayer last sent it with the account, so signing starts at once; read from the chain only
  // if it has not come. Every call that uses one up goes through the relayer, which sends the account again after.
  const nonceFor = useCallback(async (who: Address) => {
    const a = accountRef.current;
    return a?.nonce != null && a.player.toLowerCase() === who.toLowerCase() ? BigInt(a.nonce) : gameNonce(who);
  }, []);

  // A session is good for an hour at least: checked against a clock that ticks now and then.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const sessionOk = useMemo(() => {
    if (!account || !key) return false;
    const s = account.session;
    return s.x.toLowerCase() === key.x.toLowerCase() && s.y.toLowerCase() === key.y.toLowerCase() && Number(s.validUntil) * 1000 > now + 3_600_000 && BigInt(s.allowance) > 0n;
  }, [account, key, now]);

  const enableSession = useCallback(async (): Promise<string | null> => {
    if (!player || !domain || !hello) return "Not connected";
    let k = key;
    if (!k) {
      try {
        k = await sessionKey();
        setKey(k);
      } catch {
        return "This browser can't play. Try another one.";
      }
    }
    setRegistering(true);
    try {
      const nonce = await nonceFor(player);
      const validUntil = BigInt(Math.floor(Date.now() / 1000) + SESSION_DAYS * 86_400);
      const dl = deadline();
      const message = { player, kind: 1, key: "0x0000000000000000000000000000000000000000", x: k.x, y: k.y, validUntil, allowance: SESSION_ALLOWANCE, nonce, deadline: dl };
      const sig = await me.signTypedData({ domain, types: { Session: [...TYPES.Session] }, primaryType: "Session", message });
      if (!sig) return "Not signed";
      const r = await client.request({ type: "session", ...message, sig }, (m): m is Extract<Incoming, { type: "session-set" }> => m.type === "session-set", 30_000);
      if (!r) return "No answer";
      if (!r.ok) {
        track("drawing_key_failed", { why: r.why ?? "refused" });
        return r.why ?? "Could not get ready";
      }
      track("drawing_key_ready");
      client.send({ type: "account" });
      return null;
    } catch (e) {
      track("drawing_key_failed", { why: String((e as Error).message ?? e).slice(0, 120) });
      reportError(e, { flow: "drawing_key" });
      return String((e as Error).message ?? e);
    } finally {
      setRegistering(false);
    }
  }, [player, hello, key, me, client, nonceFor]);

  const deposit = useCallback(
    async (usdc: number): Promise<string | null> => {
      if (!player || !hello || !GAME) return "Not connected";
      const value = BigInt(Math.round(usdc * 1e6));
      if (value <= 0n) return "Nothing to deposit";
      try {
        // Move this USDC to the game, good for ten minutes, under a nonce nobody else will ever pick.
        const nonce = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
        const validBefore = BigInt(Math.floor(Date.now() / 1000) + 600);
        const message = { from: player, to: GAME, value, validAfter: 0n, validBefore, nonce };
        const sig = await me.signTypedData({ domain: await usdcDomain(), types: { ReceiveWithAuthorization: [...RECEIVE_WITH_AUTHORIZATION_TYPES.ReceiveWithAuthorization] }, primaryType: "ReceiveWithAuthorization", message });
        if (!sig) return "Not signed";
        const r = await client.request({ type: "deposit", owner: player, amount: value, validAfter: 0n, validBefore, nonce, sig }, (m): m is Extract<Incoming, { type: "deposited" }> => m.type === "deposited", 30_000);
        if (!r || !r.ok) {
          track("deposit_failed", { amount: usdc, why: r ? (r.why ?? "refused") : "no answer" });
          return r ? (r.why ?? "Could not add") : "No answer";
        }
        track("deposit_completed", { amount: usdc });
        return null;
      } catch (e) {
        track("deposit_failed", { amount: usdc, why: String((e as Error).message ?? e).slice(0, 120) });
        reportError(e, { flow: "deposit", amount: usdc });
        return String((e as Error).message ?? e);
      }
    },
    [player, hello, me, client],
  );

  const withdraw = useCallback(
    async (usdc: number, to: Address): Promise<{ tx: string } | { why: string }> => {
      if (!player || !domain) return { why: "Not connected" };
      const value = BigInt(Math.round(usdc * 1e6));
      if (value <= 0n) return { why: "Nothing to withdraw" };
      try {
        const nonce = await nonceFor(player);
        const dl = deadline();
        const message = { player, amount: value, to, nonce, deadline: dl };
        const sig = await me.signTypedData({ domain, types: { Withdraw: [...TYPES.Withdraw] }, primaryType: "Withdraw", message });
        if (!sig) return { why: "Not signed" };
        const before = saidRef.current;
        const r = await client.request({ type: "withdraw", ...message, sig }, (m): m is Extract<Incoming, { type: "withdrawn" }> => m.type === "withdrawn", 45_000);
        if (!r || !r.ok) {
          track("withdraw_failed", { amount: usdc, why: r ? (r.why ?? "refused") : "no answer" });
          return { why: r ? (r.why ?? "Could not withdraw") : "No answer" };
        }
        track("withdraw_completed", { amount: usdc });
        // As with deposits: the balance drops before the sheet says "sent", counted here only if the relayer's
        // new figure has not arrived, so it can never be taken off twice.
        if (saidRef.current === before) nudgeRef.current(-usdc);
        return { tx: r.tx ?? "" };
      } catch (e) {
        track("withdraw_failed", { amount: usdc, why: String((e as Error).message ?? e).slice(0, 120) });
        reportError(e, { flow: "withdraw", amount: usdc });
        return { why: String((e as Error).message ?? e) };
      }
    },
    [player, me, client, nonceFor],
  );

  const walletUsdc = useCallback(() => (player ? usdcBalance(player) : Promise.resolve(0n)), [player]);

  /*
    The wallet is this game's own, made at sign-in, so USDC that lands in it is
    on its way in: moved into the balance at once, with one signature the
    wallet makes without asking. The player sees one address and one balance.
  */
  const [wallet, setWallet] = useState<number | null>(null);
  const [adding, setAdding] = useState<number | null>(null);
  const [landed, setLanded] = useState<{ amount: number; at: number } | null>(null);
  const live = Boolean(player && hello && connected);
  useEffect(() => {
    if (!live) return;
    let alive = true;
    let busy = false;
    let pausedUntil = 0;
    const look = async () => {
      if (busy || Date.now() < pausedUntil) return;
      busy = true;
      try {
        const held = Number(await usdcBalance(player!)) / 1e6;
        if (!alive) return;
        setWallet(held);
        if (held < MIN_DEPOSIT) return;
        setAdding(held);
        const before = saidRef.current;
        const why = await deposit(held);
        if (!alive) return;
        setAdding(null);
        if (why) {
          pausedUntil = Date.now() + SWEEP_BACKOFF_MS;
          if (process.env.NODE_ENV !== "production") console.warn(`[chain] could not move ${held} USDC in: ${why}`);
          return;
        }
        setWallet(0);
        // The balance must hold the deposit before the sheet says "added", or the next tap would find the old one
        // and open the sheet again. The relayer sends it first; if it has not arrived yet, count it here. Only then:
        // counted after its word came, it would be counted twice.
        if (saidRef.current === before) nudgeRef.current(held);
        setLanded({ amount: held, at: Date.now() });
      } catch {
        if (alive) setAdding(null);
      } finally {
        busy = false;
      }
    };
    void look();
    const timer = setInterval(() => void look(), SWEEP_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [live, player, deposit]);

  // A key that is not the chain's is replaced on enable.
  const value = useMemo<Chain>(
    () => ({ real: live, player, client, hello, account, connected, key, sessionOk, enableSession, registering, deposit, withdraw, walletUsdc, wallet, adding, landed, balance, nudge, resync }),
    [live, player, client, hello, account, connected, key, sessionOk, enableSession, registering, deposit, withdraw, walletUsdc, wallet, adding, landed, balance, nudge, resync],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

const OFF: Chain = {
  real: false,
  player: null,
  client: null as unknown as RelayerClient,
  hello: null,
  account: null,
  connected: false,
  key: null,
  sessionOk: false,
  enableSession: async () => "No game on chain",
  registering: false,
  deposit: async () => "No game on chain",
  withdraw: async () => ({ why: "No game on chain" }),
  walletUsdc: async () => 0n,
  wallet: null,
  adding: null,
  landed: null,
  balance: 0,
  nudge: () => undefined,
  resync: () => undefined,
};

export function useChain(): Chain {
  return useContext(Ctx) ?? OFF;
}

export type { Hex };
