import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useAccount } from "@/components/app/auth";
import { type Account, type Hello, type RelayerClient, useRelayer } from "@/lib/relayer";
import { forgetSessionKey, sessionKey, type SessionKey } from "@/lib/session";

/**
 * Real money, on Solana: the relayer, the player's account in the game, and the session key that signs their ink,
 * as on the web (`ui/app/src/components/app/ink/chain-context.tsx`). Everything the wallet signs goes through here,
 * and there is little of it: one session (which also lets USDC that lands in the wallet be swept in), and a
 * withdrawal. The relayer builds each transaction and pays for it; the phone only signs.
 */

export type Chain = {
  real: boolean;
  player: string | null;
  client: RelayerClient;
  hello: Hello | null;
  account: Account | null;
  connected: boolean;
  key: SessionKey | null;
  /** Whether the key on chain is this phone's, and still good for an hour. */
  sessionOk: boolean;
  /** Register this phone's key, and the standing approval for deposits, with one signature from the wallet. */
  enableSession: () => Promise<string | null>;
  registering: boolean;
  /** USDC from the wallet into the balance now, on a signature: for when there is no approval left to sweep on. */
  deposit: (usdc: number) => Promise<string | null>;
  /** Send `usdc` from the balance to `to` (a Solana address): the transaction, or why not. */
  withdraw: (usdc: number, to: string) => Promise<{ tx: string } | { why: string }>;
  /** USDC in the wallet itself, on its way in; null before the first word. */
  wallet: number | null;
  /** How much of the wallet's USDC the game may sweep in without asking. */
  approved: number;
  adding: number | null;
  landed: { amount: number; at: number } | null;
  balance: number;
  nudge: (usdc: number) => void;
  resync: () => void;
};

export const ChainContext = createContext<Chain | null>(null);

const SESSION_DAYS = 7;
/** How much a session may stake in all before it must be registered again: $100,000. */
const SESSION_ALLOWANCE = 100_000_000_000n;
/** How much USDC landing in the wallet the game may sweep in without asking again: $1,000,000. */
const APPROVE = 1_000_000_000_000n;
export const MIN_DEPOSIT = 1;

export function ChainProvider({ children }: { children: ReactNode }) {
  const me = useAccount();
  const player = me.signedIn ? me.address : null;
  const { client, hello, account, connected } = useRelayer(player, true);
  const [key, setKey] = useState<SessionKey | null>(null);
  const [registering, setRegistering] = useState(false);
  const [moved, setMoved] = useState<{ said: string | null; by: number }>({ said: null, by: 0 });
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let live = true;
    void sessionKey().then((k) => live && setKey(k), () => undefined);
    return () => {
      live = false;
    };
  }, []);

  const said = account?.balance ?? null;
  const balance = Math.round(((said ? Number(said) / 1e6 : 0) + (moved.said === said ? moved.by : 0)) * 1e6) / 1e6;
  const nudge = useCallback((usdc: number) => setMoved((m) => ({ said, by: (m.said === said ? m.by : 0) + usdc })), [said]);
  const resync = useCallback(() => setMoved({ said: null, by: 0 }), []);
  const saidRef = useRef(said);
  const nudgeRef = useRef(nudge);
  useEffect(() => {
    saidRef.current = said;
    nudgeRef.current = nudge;
  }, [said, nudge]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const sessionOk = useMemo(() => {
    const s = account?.session;
    if (!s || !key) return false;
    return s.key === key.address && Number(s.validUntil) * 1000 > now + 3_600_000 && BigInt(s.allowance) > 0n;
  }, [account, key, now]);

  const enableSession = useCallback(async (): Promise<string | null> => {
    if (!player || !hello) return "Not connected";
    let k = key;
    if (!k) {
      try {
        k = await sessionKey();
        setKey(k);
      } catch {
        return "This phone can't keep a key. Try again.";
      }
    }
    setRegistering(true);
    try {
      const validUntil = String(Math.floor(Date.now() / 1000) + SESSION_DAYS * 86_400);
      const r = await client.transact("session", { key: k.address, validUntil, allowance: SESSION_ALLOWANCE.toString(), approve: APPROVE.toString() }, me.signTransaction);
      if (!r.ok) return r.why;
      client.send({ type: "account" });
      return null;
    } finally {
      setRegistering(false);
    }
  }, [player, hello, key, client, me.signTransaction]);

  const deposit = useCallback(
    async (usdc: number): Promise<string | null> => {
      if (!player || !hello) return "Not connected";
      const amount = BigInt(Math.round(usdc * 1e6));
      if (amount <= 0n) return "Nothing to deposit";
      const r = await client.transact("deposit", { amount: amount.toString() }, me.signTransaction);
      return r.ok ? null : r.why;
    },
    [player, hello, client, me.signTransaction],
  );

  const withdraw = useCallback(
    async (usdc: number, to: string): Promise<{ tx: string } | { why: string }> => {
      if (!player) return { why: "Not connected" };
      const amount = BigInt(Math.round(usdc * 1e6));
      if (amount <= 0n) return { why: "Nothing to withdraw" };
      const before = saidRef.current;
      const r = await client.transact("withdraw", { amount: amount.toString(), to }, me.signTransaction);
      if (!r.ok) return { why: r.why };
      if (saidRef.current === before) nudgeRef.current(-usdc);
      return { tx: r.tx };
    },
    [player, client, me.signTransaction],
  );

  /*
    USDC that lands in the wallet is on its way in. With the session's standing approval the relayer sweeps it in
    by itself; the app asks it to look now rather than on its next round. With no approval left, a Coinbase wallet
    signs the deposit without asking, as on the web; a wallet on the phone would prompt, so the sheet offers it.
  */
  const wallet = account ? Number(account.wallet.usdc) / 1e6 : null;
  const approved = account ? Number(account.wallet.approved) / 1e6 : 0;
  const [adding, setAdding] = useState<number | null>(null);
  const [landed, setLanded] = useState<{ amount: number; at: number } | null>(null);
  const live = Boolean(player && hello && connected);
  const pending = useRef<{ amount: number; before: string | null } | null>(null);
  useEffect(() => {
    if (!live || wallet === null || wallet < MIN_DEPOSIT) return;
    if (pending.current) return;
    pending.current = { amount: wallet, before: saidRef.current };
    setAdding(wallet);
    if (approved >= wallet) client.send({ type: "sweep" });
    else if (me.kind === "coinbase")
      void deposit(wallet).then((why) => {
        if (why) {
          pending.current = null;
          setAdding(null);
        }
      });
    else {
      pending.current = null;
      setAdding(null);
    }
  }, [live, wallet, approved, client, deposit, me.kind]);
  // Landed: the wallet emptied into the balance.
  useEffect(() => {
    const p = pending.current;
    if (!p || wallet === null || wallet >= MIN_DEPOSIT) return;
    pending.current = null;
    setAdding(null);
    if (saidRef.current === p.before) nudgeRef.current(p.amount);
    setLanded({ amount: p.amount, at: Date.now() });
  }, [wallet]);

  const value = useMemo<Chain>(
    () => ({ real: live, player, client, hello, account, connected, key, sessionOk, enableSession, registering, deposit, withdraw, wallet, approved, adding, landed, balance, nudge, resync }),
    [live, player, client, hello, account, connected, key, sessionOk, enableSession, registering, deposit, withdraw, wallet, approved, adding, landed, balance, nudge, resync],
  );
  return <ChainContext.Provider value={value}>{children}</ChainContext.Provider>;
}

export function useChain(): Chain {
  const c = useContext(ChainContext);
  if (!c) throw new Error("useChain outside ChainProvider");
  return c;
}

export { forgetSessionKey };
