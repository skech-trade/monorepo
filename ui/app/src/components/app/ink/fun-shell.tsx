"use client";

import { AppBar } from "@/components/app/app-bar";
import { useSettings } from "@/lib/settings";
import { InkScreen } from "./ink-screen";

/**
 * The page around the game: the app's own bar over the game, the same shell
 * the trading screen sits in, held to the screen's height so a finger
 * drawing never drags the page instead.
 */
export function FunShell() {
  const [{ blurred }] = useSettings();
  return (
    <div className="flex h-svh flex-col overscroll-none bg-background [-webkit-touch-callout:none]" data-blurred={blurred ? "" : undefined}>
      <AppBar />
      <main className="flex min-h-0 w-full flex-1 flex-col overflow-hidden bg-muted/40">
        <InkScreen />
      </main>
    </div>
  );
}
