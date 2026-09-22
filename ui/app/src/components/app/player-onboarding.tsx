"use client";

import { useState } from "react";
import { CheckIcon, PencilLineIcon, PlayIcon, Share2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetDescription, SheetHeader, SheetPanel, SheetPopup, SheetTitle } from "@/components/ui/sheet";
import type { Player, PlayerState } from "@/lib/social";
import { buddyArtwork } from "./draw/buddy-art";
import { BUDDY_COLORS } from "./draw/share-style";

export function Buddy({ color = "blue", className = "h-28 w-24" }: { color?: Player["buddy"]; className?: string }) {
  return <svg aria-hidden="true" viewBox="0 0 100 130" className={className} fill="none">{buddyArtwork(BUDDY_COLORS[color]).map((part,i) => <path key={i} d={part.d} fill={part.fill ?? "none"} stroke={part.stroke} strokeWidth={part.width} opacity={part.opacity} strokeLinecap="round" strokeLinejoin="round"/>)}</svg>;
}

export function PlayerOnboarding({ social, open, onOpenChange, onDeposit }: { social: PlayerState; open: boolean; onOpenChange: (open: boolean) => void; onDeposit: () => void }) {
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [color, setColor] = useState<Player["buddy"] | null>(null);
  const buddy = color ?? social.player?.buddy ?? "blue";
  const titles = ["Make it yours.", "Meet your Sketch buddy.", "Your next move."];
  return <Sheet open={open} onOpenChange={onOpenChange}>
    <SheetPopup side="right" variant="inset" className="sm:max-w-md">
      <SheetHeader className="px-6 pt-8 sm:px-8">
        <p className="mb-5 text-xs font-medium tracking-widest text-muted-foreground">WELCOME TO SKECH · {step + 1} OF 3</p>
        <SheetTitle className="text-3xl font-semibold tracking-tight">{titles[step]}</SheetTitle>
        <SheetDescription>{["A name for your predictions. A profile that grows with you.", "Your Skech character, ready to draw with you.", "Draw a prediction, watch it unfold, and share your story."][step]}</SheetDescription>
      </SheetHeader>
      <SheetPanel className="space-y-6 px-6 pb-8 sm:px-8">
        <div className="flex h-40 items-center justify-center rounded-3xl border border-primary/15 bg-primary/5"><Buddy color={buddy}/></div>
        {step === 0 ? <>
          {social.player ? <div className="rounded-2xl border p-5"><p className="text-lg font-semibold">@{social.player.username}</p><p className="mt-1 text-sm text-muted-foreground">Level {social.player.level} · {social.player.points} points</p></div> : <form className="space-y-3" onSubmit={e => {e.preventDefault(); void social.claim(name);}}>
            <label htmlFor="claim-username" className="text-sm font-medium">Your username</label>
            <Input id="claim-username" className="h-12" autoComplete="username" autoCapitalize="none" spellCheck={false} placeholder="your_name" maxLength={20} value={name} onChange={e => setName(e.target.value.toLowerCase())} aria-describedby="username-hint"/>
            <p id="username-hint" className="text-xs leading-relaxed text-muted-foreground">3–20 characters. Start with a letter; numbers and underscores welcome. Already joined? Use your claimed name to reconnect.</p>
            <Button className="h-12 sm:h-12 w-full" type="submit" disabled={social.busy || !/^[a-z][a-z0-9_]{2,19}$/.test(name)} loading={social.busy}>Claim username</Button>
            <p className="text-xs leading-relaxed text-muted-foreground">Confirm ownership with a wallet signature. No transaction or fee. Your wallet is available from the account menu.</p>
          </form>}
          {social.player ? <Button className="h-12 sm:h-12 w-full" onClick={() => setStep(1)}>Choose your buddy</Button> : null}
        </> : step === 1 ? <>
          <div role="group" aria-label="Buddy color" className="grid grid-cols-3 gap-3">{(["blue", "mint", "coral"] as const).map(c => <Button key={c} className="h-12 sm:h-12 gap-2" variant={buddy === c ? "default" : "outline"} aria-pressed={buddy === c} onClick={() => setColor(c)}><span className="size-3 rounded-full border border-white/40" style={{background:BUDDY_COLORS[c]}}/>{c[0].toUpperCase()+c.slice(1)}{buddy === c ? <CheckIcon className="size-3"/> : null}</Button>)}</div>
          <p className="text-sm leading-relaxed text-muted-foreground">Your buddy comes along on shared cards and clips. You can change its color anytime in Your profile.</p>
          <Button className="h-12 sm:h-12 w-full" loading={social.busy} disabled={social.busy} onClick={async () => {if(await social.saveBuddy(buddy)) setStep(2);}}>Save and continue</Button>
        </> : <>
          <div className="space-y-5">{[[PencilLineIcon,"Draw your prediction","Sketch where you think Bitcoin goes next."],[PlayIcon,"Watch it unfold","Compare your line with the live market."],[Share2Icon,"Make it yours","Create a card or replay with your buddy."]].map(([Icon,title,copy]) => {const Mark = Icon as typeof PencilLineIcon;return <div key={String(title)} className="flex gap-3"><span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"><Mark className="size-4"/></span><div><p className="text-sm font-medium">{String(title)}</p><p className="mt-1 text-xs leading-relaxed text-muted-foreground">{String(copy)}</p></div></div>;})}</div>
          <div className="rounded-2xl border p-4"><p className="text-sm font-medium">A little progress with every prediction.</p><p className="mt-2 text-xs leading-relaxed text-muted-foreground">Your profile saves points, levels and achievements. Points have no cash value; deposits and leverage don’t earn them.</p></div>
          <Button className="h-12 sm:h-12 w-full" onClick={() => onOpenChange(false)}>Start drawing</Button>
          <Button className="h-11 sm:h-11 w-full" variant="outline" onClick={() => {onOpenChange(false);onDeposit();}}>Explore funding options</Button>
        </>}
        {social.note ? <p role="status" className="text-sm leading-relaxed text-muted-foreground">{social.note}</p> : null}
        <div className="flex items-center justify-between">{step > 0 ? <Button variant="ghost" onClick={() => setStep(step-1)}>Back</Button> : <span/>}{step < 2 ? <Button variant="ghost" disabled={social.busy} onClick={() => onOpenChange(false)}>Set up later</Button> : null}</div>
      </SheetPanel>
    </SheetPopup>
  </Sheet>;
}
