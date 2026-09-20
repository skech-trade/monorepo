"use client";

import { AuthButton } from "@coinbase/cdp-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogHeader, DialogPanel, DialogPopup, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

/**
 * Coinbase's own sign-in, in our own dialog.
 *
 * Their button opens a flow that handles email codes, phone codes and Google,
 * and makes the wallet at the end of it. Wrapping it rather than rebuilding
 * it: the one-time codes and the recovery are theirs to get right, and this
 * is the screen where getting it wrong locks someone out of their money.
 */
export function SignInButton({ className }: { className?: string }) {
  return (
    <Dialog>
      <DialogTrigger render={<Button className={className} size="sm" />}>Sign in</DialogTrigger>
      <DialogPopup className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Sign in</DialogTitle>
          <DialogDescription>Email, phone or Google. No extension, no seed phrase.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <AuthButton />
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
