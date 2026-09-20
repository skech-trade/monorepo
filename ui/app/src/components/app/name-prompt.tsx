"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

/**
 * What to call you.
 *
 * A wallet address is not a name. "Hola, 0x3e32…0136" is the app admitting it
 * does not know who you are, and it is the first thing you read after signing
 * in. Asked once, on the first visit after signing in, and skippable: nothing
 * downstream needs it, so refusing costs nothing.
 */
export function NamePrompt({ open, onOpenChange, onSave }: { open: boolean; onOpenChange: (open: boolean) => void; onSave: (name: string) => Promise<string | null> }) {
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
