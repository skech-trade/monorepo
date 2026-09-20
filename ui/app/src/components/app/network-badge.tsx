"use client";

/**
 * Which Lighter this is.
 *
 * Testnet and mainnet look identical on every screen and only one of them
 * costs anybody anything, so the one that does not says so. It is quiet, in
 * the corner, and it is not there at all on mainnet, where the absence of a
 * badge is the message.
 */
export function NetworkBadge() {
  if (process.env.NEXT_PUBLIC_SKECH_NETWORK === "mainnet") return null;
  return (
    <span
      className="inline-flex shrink-0 rounded-full border border-warning-foreground/32 bg-warning/12 px-2 py-0.5 font-medium text-[11px] text-warning-foreground"
      title="Orders are signed and settled for real, with money that is not."
    >
      {/* Shorter on a phone, never gone. Being on testnet without knowing it
          is worse on the screen somebody carries than on the one they sit at,
          and the bar there has no room for the longer word. */}
      <span className="sm:hidden">Test</span>
      <span className="max-sm:hidden">Testnet</span>
    </span>
  );
}
