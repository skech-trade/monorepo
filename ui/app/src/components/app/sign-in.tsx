"use client";

import { SignInModal } from "@coinbase/cdp-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

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
      {/* Matched to the toggle beside it on a phone, where it was forty
          against forty-four and the two sat on different centre lines in the
          same bar. The small size is kept for the desk, unchanged. */}
      <Button className={cn("max-sm:h-11 max-sm:px-4", className)} onClick={() => setOpen(true)} size="sm">
        Sign in
      </Button>
    </SignInModal>
  );
}
