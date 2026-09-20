"use client";

import { SignInModal } from "@coinbase/cdp-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * Our button, Coinbase's panel.
 *
 * The modal is theirs and stays theirs: the one-time codes and the recovery
 * are the parts that lock someone out of their money if they are got wrong.
 * The trigger is ours, so the corner of the app looks like the rest of it.
 */
export function SignInButton({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <SignInModal open={open} setIsOpen={setOpen}>
      <Button className={className} onClick={() => setOpen(true)} size="sm">
        Sign in
      </Button>
    </SignInModal>
  );
}
