"use client";

import { cn } from "@/lib/utils";

/**
 * Which Lighter this is.
 *
 * Testnet and mainnet look identical on every screen and only one of them
 * costs anybody anything, so the one that does not says so. It is quiet, in
 * the corner, and it is not there at all on mainnet, where the absence of a
 * badge is the message.
 */
export function NetworkBadge({ className, compact }: { className?: string; compact?: boolean }) {
  if (process.env.NEXT_PUBLIC_SKECH_NETWORK === "mainnet") return null;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 rounded-full border border-warning-foreground/32 bg-warning/12 px-2 py-0.5 font-medium text-[11px] text-warning-foreground",
        className,
      )}
      title="Orders are signed and settled for real, with money that is not."
    >
      {/* Shorter where it rides along with the price, never gone. Being on
          testnet without knowing it is worse on the screen somebody carries
          than on the one they sit at. */}
      {compact ? "Test" : "Testnet"}
    </span>
  );
}
