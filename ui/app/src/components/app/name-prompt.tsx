"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { shortAddress } from "./auth";

/**
 * What to call you, and what just happened to you.
 *
 * Two things belong in the first thing somebody reads after signing in. One:
 * a wallet address is not a name, so it asks for one, once, and a skip counts
 * as an answer. Two: signing in made them a wallet, which nobody agreed to
 * and nobody was told. Saying it here costs a line and means the address in
 * the corner is not a surprise.
 */
export function NamePrompt({ address, open, onOpenChange, onSave }: { address: string | null; open: boolean; onOpenChange: (open: boolean) => void; onSave: (name: string) => Promise<string | null> }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const tooShort = name.trim().length < 2;

  const save = async () => {
    if (tooShort) return;
    setBusy(true);
    setProblem(null);
    const saved = await onSave(name.trim());
    setBusy(false);
    if (!saved) {
      setProblem("That did not save. Try again in a moment.");
      return;
    }
    onOpenChange(false);
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogPopup className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>What should we call you?</DialogTitle>
          <DialogDescription>It goes above your rounds. You can skip this.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <Input
            autoComplete="nickname"
            maxLength={24}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void save();
            }}
            placeholder="vivek"
            value={name}
          />
          {problem ? <p className="pt-2 text-down text-xs">{problem}</p> : null}
          {address ? (
            <p className="pt-3 text-muted-foreground text-xs leading-snug">
              Signing in made you a wallet, <span className="figures text-foreground">{shortAddress(address)}</span>. It is yours and nobody else holds it. The
              key is in Settings whenever you want it.
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} variant="ghost">
            Skip
          </Button>
          <Button disabled={tooShort} loading={busy} onClick={() => void save()}>
            Save
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
