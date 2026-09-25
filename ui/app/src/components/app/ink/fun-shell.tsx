"use client";

import { AppBar } from "@/components/app/app-bar";
import { cents, setPractice } from "@/lib/practice";
import { useSettings } from "@/lib/settings";
import { DepositButton } from "./ink-controls";
import { InkScreen } from "./ink-screen";

/**
 * The page around the game: the app's own bar over the game, the same shell
 * the trading screen sits in, held to the screen's height so a finger
 * drawing never drags the page instead. Deposit sits in the bar, just left
 * of the way in, on every screen.
 */
export function FunShell() {
  const [{ blurred }] = useSettings();
  return (
    <div className="fixed inset-0 flex h-dvh w-full flex-col overflow-hidden overscroll-none bg-background [-webkit-touch-callout:none]" data-blurred={blurred ? "" : undefined}>
      <div className="absolute inset-x-0 top-0 z-30 [&>header]:border-0 [&>header]:bg-transparent [&>header]:px-4 sm:[&>header]:px-6">
        <AppBar lead={<DepositButton onDeposit={(amount) => setPractice((st) => ({ balance: cents(st.balance + amount) }))} />} showTheme={false} />
      </div>
      <main className="absolute inset-0 flex min-h-0 w-full flex-col overflow-hidden">
        <InkScreen />
      </main>
    </div>
  );
}
