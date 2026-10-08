"use client";

import dynamic from "next/dynamic";
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { useSignIn } from "@/components/app/auth";
import { track } from "@/lib/analytics";

/**
 * The way to money while the game plays on: tap the game without a balance
 * and this opens, signed in or not. Signed out it is Privy's sign-in;
 * signed in, the deposit sheet (deposit-modal.tsx); from the account menu,
 * the withdrawal (withdraw-sheet.tsx).
 *
 * The two sheets are always mounted, as the deposit sheet has to be to
 * open itself when a deposit lands, but their code (the QR code, the
 * camera's scanner) is not in the page's first load: each comes in its own
 * chunk once the page is up. Privy's panel is mounted by auth.tsx, likewise
 * after the page.
 */

const DepositModal = dynamic(() => import("./deposit-modal").then((m) => m.DepositModal), { ssr: false });
const WithdrawSheet = dynamic(() => import("./withdraw-sheet").then((m) => m.WithdrawSheet), { ssr: false });

/** `"tap"`: opened because a tap on the game could not be played. Those are counted: see FOUNDERS_AFTER. */
type Gate = { openDeposit: (why?: "tap" | "short") => void; openSignIn: (from?: string) => void; openWithdraw: () => void };
const GateCtx = createContext<Gate>({ openDeposit: () => undefined, openSignIn: () => undefined, openWithdraw: () => undefined });
export const useGate = () => useContext(GateCtx);

/*
  Someone who has tapped the game five times with nothing to play with and still not deposited is stuck, not
  uninterested. From then on the sheet leads with a person: a founder, on Telegram, who will get them in. The
  count lives in this browser across reloads, and resets once there is money to play with.
*/
const FOUNDERS_AFTER = 5;
const TAPS_KEY = "skech:blocked-taps";
const readTaps = () => {
  try {
    return Number(localStorage.getItem(TAPS_KEY)) || 0;
  } catch {
    return 0;
  }
};
const writeTaps = (n: number) => {
  try {
    localStorage.setItem(TAPS_KEY, String(n));
  } catch {
    /* private mode: counted for this page only */
  }
};

export function GateProvider({ children }: { children: ReactNode }) {
  const [deposit, setDeposit] = useState(false);
  const signIn = useSignIn();
  // Read once, at start: on the server there is no storage and it is 0; the sheet is closed there anyway.
  const [taps, setTaps] = useState(readTaps);
  const openDeposit = useCallback((why?: "tap" | "short") => {
    track("deposit_opened", { why: why ?? "button" });
    if (why === "tap") {
      const n = readTaps() + 1;
      writeTaps(n);
      setTaps(n);
    }
    setDeposit(true);
  }, []);
  const openSignIn = useCallback((from = "button") => {
    track("sign_in_opened", { from });
    signIn();
  }, [signIn]);
  const [withdraw, setWithdraw] = useState(false);
  const openWithdraw = useCallback(() => setWithdraw(true), []);
  const gate = useMemo(() => ({ openDeposit, openSignIn, openWithdraw }), [openDeposit, openSignIn, openWithdraw]);
  return (
    <GateCtx.Provider value={gate}>
      {children}
      <DepositModal
        onOpenChange={setDeposit}
        onPlayable={() => {
          writeTaps(0);
          setTaps(0);
        }}
        open={deposit}
        stuck={taps >= FOUNDERS_AFTER}
      />
      <WithdrawSheet onOpenChange={setWithdraw} open={withdraw} />
    </GateCtx.Provider>
  );
}
