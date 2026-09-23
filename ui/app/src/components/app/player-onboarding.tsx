"use client";

import { useState } from "react";
import { CheckIcon, PencilLineIcon, PlayIcon, Share2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group";
import { Sheet, SheetDescription, SheetFooter, SheetHeader, SheetPanel, SheetPopup, SheetTitle } from "@/components/ui/sheet";
import type { Player, PlayerState } from "@/lib/social";
import { cn } from "@/lib/utils";
import { buddyArtwork } from "./draw/buddy-art";
import { BUDDY_COLORS } from "./draw/share-style";

export function Buddy({ color = "blue", className = "h-28 w-24" }: { color?: Player["buddy"]; className?: string }) {
  return (
    <svg aria-hidden="true" className={className} fill="none" viewBox="0 0 100 130">
      {buddyArtwork(BUDDY_COLORS[color]).map((part, i) => (
        <path d={part.d} fill={part.fill ?? "none"} key={i} opacity={part.opacity} stroke={part.stroke} strokeLinecap="round" strokeLinejoin="round" strokeWidth={part.width} />
      ))}
    </svg>
  );
}

const USERNAME = /^[a-z][a-z0-9_]{2,19}$/;
const COLORS = ["blue", "mint", "coral"] as const;
const STEPS = [
  { title: "Pick a username", copy: "It goes on your predictions and the cards you share." },
  { title: "Choose your buddy", copy: "It comes along on your cards and replays." },
  { title: "You’re set", copy: "Draw where the price goes next, then watch it play out." },
] as const;
const HOW = [
  [PencilLineIcon, "Draw your prediction", "Sketch where you think the price goes next."],
  [PlayIcon, "Watch it unfold", "Your line trades against the live market."],
  [Share2Icon, "Share the story", "Save a card or replay with your buddy."],
] as const;

/** Three steps: a name, a buddy, and how it works. Every step can be skipped. */
export function PlayerOnboarding({ social, open, onOpenChange, onDeposit }: { social: PlayerState; open: boolean; onOpenChange: (open: boolean) => void; onDeposit: () => void }) {
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [color, setColor] = useState<Player["buddy"] | null>(null);
  const buddy = color ?? social.player?.buddy ?? "blue";
  const valid = USERNAME.test(name);
  // Only say something is wrong once there is enough typed to be wrong.
  const invalid = name.length >= 3 && !valid;
  const close = () => onOpenChange(false);

  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetPopup className="sm:max-w-md" side="right" variant="inset">
        <SheetHeader className="gap-3 px-6 pt-7 sm:px-8">
          <div aria-label={`Step ${step + 1} of 3`} className="flex gap-1.5" role="img">
            {STEPS.map((_, i) => (
              <span className={cn("h-1 w-8 rounded-full transition-colors", i <= step ? "bg-primary" : "bg-muted")} key={i} />
            ))}
          </div>
          <SheetTitle className="text-2xl font-semibold tracking-tight">{STEPS[step].title}</SheetTitle>
          <SheetDescription>{STEPS[step].copy}</SheetDescription>
        </SheetHeader>

        <SheetPanel className="flex flex-col gap-6 px-6 sm:px-8">
          <div className="flex h-36 items-center justify-center rounded-2xl bg-muted/50">
            <Buddy className="h-28 w-24" color={buddy} />
          </div>

          {step === 0 ? (
            social.player ? (
              <div className="rounded-xl border px-4 py-3">
                <p className="font-medium">@{social.player.username}</p>
                <p className="mt-0.5 text-muted-foreground text-sm">
                  Level {social.player.level} · {social.player.points} points
                </p>
              </div>
            ) : (
              <form
                id="claim"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (valid) void social.claim(name);
                }}
              >
                <Field className="w-full" invalid={invalid}>
                  <FieldLabel>Username</FieldLabel>
                  <InputGroup className="w-full">
                    <InputGroupAddon>
                      <InputGroupText>@</InputGroupText>
                    </InputGroupAddon>
                    <InputGroupInput
                      aria-invalid={invalid || undefined}
                      autoCapitalize="none"
                      autoComplete="username"
                      maxLength={20}
                      onChange={(e) => setName(e.target.value.toLowerCase().replace(/\s/g, ""))}
                      placeholder="your_name"
                      size="lg"
                      spellCheck={false}
                      value={name}
                    />
                  </InputGroup>
                  <FieldDescription className={cn(invalid && "text-destructive-foreground")}>
                    {invalid ? "Start with a letter. Letters, numbers and _ only." : "3–20 characters. Already joined? Use your name to sign back in."}
                  </FieldDescription>
                </Field>
              </form>
            )
          ) : step === 1 ? (
            <div aria-label="Buddy colour" className="grid grid-cols-3 gap-3" role="radiogroup">
              {COLORS.map((c) => (
                <button
                  aria-checked={buddy === c}
                  className={cn(
                    "flex flex-col items-center gap-2 rounded-xl border px-3 py-3 text-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    buddy === c && "border-primary bg-primary/5",
                  )}
                  key={c}
                  onClick={() => setColor(c)}
                  role="radio"
                  type="button"
                >
                  <span className="flex size-7 items-center justify-center rounded-full text-white" style={{ background: BUDDY_COLORS[c] }}>
                    {buddy === c ? <CheckIcon className="size-4" /> : null}
                  </span>
                  {c[0].toUpperCase() + c.slice(1)}
                </button>
              ))}
            </div>
          ) : (
            <ul className="flex flex-col gap-4">
              {HOW.map(([Icon, title, copy]) => (
                <li className="flex gap-3" key={title}>
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                    <Icon className="size-4" />
                  </span>
                  <span>
                    <span className="block font-medium text-sm">{title}</span>
                    <span className="block text-muted-foreground text-sm">{copy}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}

          {social.note ? (
            <p className="text-muted-foreground text-sm" role="status">
              {social.note}
            </p>
          ) : null}
        </SheetPanel>

        <SheetFooter className="flex-col gap-2 px-6 sm:flex-col sm:px-8" variant="bare">
          {step === 0 ? (
            social.player ? (
              <Button className="w-full" onClick={() => setStep(1)} size="lg">
                Continue
              </Button>
            ) : (
              <>
                <Button className="w-full" disabled={social.busy || !valid} form="claim" loading={social.busy} size="lg" type="submit">
                  Claim @{name || "username"}
                </Button>
                <p className="text-center text-muted-foreground text-xs">You&rsquo;ll sign with your wallet. It&rsquo;s free and moves no funds.</p>
              </>
            )
          ) : step === 1 ? (
            <Button
              className="w-full"
              disabled={social.busy}
              loading={social.busy}
              onClick={async () => {
                if (await social.saveBuddy(buddy)) setStep(2);
              }}
              size="lg"
            >
              Continue
            </Button>
          ) : (
            <>
              <Button className="w-full" onClick={close} size="lg">
                Start drawing
              </Button>
              <Button
                className="w-full"
                onClick={() => {
                  close();
                  onDeposit();
                }}
                size="lg"
                variant="outline"
              >
                Add funds
              </Button>
            </>
          )}
          <div className="flex items-center justify-between pt-1">
            {step > 0 ? (
              <Button onClick={() => setStep(step - 1)} size="sm" variant="ghost">
                Back
              </Button>
            ) : (
              <span />
            )}
            {step < 2 ? (
              <Button disabled={social.busy} onClick={close} size="sm" variant="ghost">
                Skip for now
              </Button>
            ) : null}
          </div>
        </SheetFooter>
      </SheetPopup>
    </Sheet>
  );
}
