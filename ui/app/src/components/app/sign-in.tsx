"use client";

import { AuthButton } from "@coinbase/cdp-react";

/**
 * Coinbase's own sign-in button.
 *
 * It is a trigger, not a form: pressing it opens their modal, which handles
 * the email and phone codes, Google, and making the wallet at the end. That
 * belongs to them. The one-time codes and the recovery are the part that
 * locks someone out of their money if it is got wrong, so it is not ours to
 * rebuild.
 *
 * It was inside a dialog of ours for a moment, which put a button inside a
 * dialog that opened nothing. It sits in the header now, where it is the one
 * thing a signed-out reader can press.
 */
export function SignInButton({ className }: { className?: string }) {
  return (
    <div className={className} data-slot="sign-in">
      <AuthButton />
    </div>
  );
}
