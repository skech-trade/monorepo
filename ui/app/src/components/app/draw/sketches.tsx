"use client";

import { CheckIcon, DownloadIcon, FilmIcon, PlayIcon, Share2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader } from "@/components/ui/empty";
import { Sheet, SheetHeader, SheetPanel, SheetPopup, SheetTitle } from "@/components/ui/sheet";
import { type Candle, type Market, price as fmtPrice, signedUsd, usd } from "@/lib/market";
import { legPath, type Outcome, type Pt } from "@/lib/sketch";
import { cn } from "@/lib/utils";
import { ClipPlayer } from "./clip-player";
import { canRecordVideo, canShareFile, type Clip, copyPicture, saveBlob, shareOrSave, xPostUrl } from "@/lib/share";
import { exportPng, recordClip, RoundCanvas } from "./round-card";
import { PlayerCard } from "./player-card";
import type { PlayerState } from "@/lib/social";
import { DEFAULT_SHARE_STYLE, type ShareStyle } from "./share-style";
import { postText } from "./round-copy";

/** A sketch is a position you can look at. The list keeps the drawing. */
export type Sketch = {
  id: string;
  venueId?: string;
  pnlReady?: boolean;
  /** Public display name captured when the prediction was placed. */
  author?: string;
  long: boolean;
  stake: number;
  leverage: number;
  entry: number;
  pts: Pt[];
  placedAt: number;
  status: "running" | "settled";
  net: number;
  exit?: number;
  /** The round, kept: what arrived, how long it was, how it ended. */
  run?: Candle[];
  runBars?: number;
  outcome?: Outcome | "closed";
  /** Share of the move that went your way, 0 to 1. Over a half means it profited. */
  right?: number;
};

function SketchThumb({ sketch, className }: { sketch: Sketch; className?: string }) {
  const W = 96;
  const H = 56;
  const prices = sketch.pts.map((p) => p.price).concat(sketch.entry);
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  const pad = (hi - lo || sketch.entry * 0.01) * 0.15;
  const y = (p: number) => 8 + ((hi + pad - p) / (hi - lo + pad * 2)) * (H - 16);
  const pts = sketch.pts.map((p) => ({ x: 6 + p.t * (W - 12), y: y(p.price) }));
  const head = pts.at(-1);
  return (
    <svg aria-hidden="true" className={cn("rounded-md border bg-muted/40", className)} viewBox={`0 0 ${W} ${H}`}>
      <line stroke="var(--muted-foreground)" strokeDasharray="2 3" strokeOpacity="0.5" x1="0" x2={W} y1={y(sketch.entry)} y2={y(sketch.entry)} />
      <path d={legPath(pts)} fill="none" stroke="var(--brand)" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
      {head ? <circle cx={head.x} cy={head.y} fill="var(--brand)" r="2.4" /> : null}
    </svg>
  );
}

/** Wins in a row, counting back from the latest settled round. */
function streakOf(sketches: Sketch[]): number {
  let n = 0;
  for (const s of sketches) {
    if (s.status !== "settled") continue;
    if (s.net >= 0) n += 1;
    else break;
  }
  return n;
}

/** The X mark. Lucide dropped the bird and never drew the X. */
function XMark() {
  return (
    <svg aria-hidden="true" fill="currentColor" viewBox="0 0 24 24">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

/** How a round ended, in words. */
function outcomeLabel(outcome: Sketch["outcome"]): string {
  if (outcome === "closed") return "Closed early";
  if (outcome === "stop") return "Stop loss reached";
  if (outcome === "target") return "Take profit reached";
  if (outcome === "liquidated") return "Liquidated";
  return "Round complete";
}

/** The latest round as a card: the canvas, the buttons, nothing else. */
function RoundCard({ sketch, market, streak, onNext, buddy }: { sketch: Sketch; market: Market; streak: number; onNext?: () => void; buddy?: ShareStyle["buddy"] }) {
  const [play, setPlay] = useState(0);
  const [studio, setStudio] = useState(false);
  const [style, setStyle] = useState<ShareStyle>({ ...DEFAULT_SHARE_STYLE, buddy: buddy ?? "blue" });
  const [busy, setBusy] = useState<"png" | "clip" | null>(null);
  const [done, setDone] = useState<string | null>(null);
  /** A recorded clip waits here for the click that saves or shares it. */
  const [clip, setClip] = useState<(Clip & { url: string }) | null>(null);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    if (!clip) return;
    const { url } = clip;
    return () => URL.revokeObjectURL(url);
  }, [clip]);
  const text = postText(sketch, market, streak, style.showMoney);

  const say = (w: string) => {
    setDone(w);
    setTimeout(() => setDone(null), 1800);
  };

  /** A picture is quick, so it goes straight to the share sheet or a download off this click. */
  const picture = async () => {
    setBusy("png");
    setNote(null);
    try {
      const blob = await exportPng(sketch, market, streak, style);
      say((await shareOrSave(blob, `skech-${market.symbol.toLowerCase()}-round.png`, text)) === "shared" ? "Shared" : "Saved");
    } catch (e) {
      if ((e as DOMException).name !== "AbortError") setNote("Couldn't make the picture here.");
    } finally {
      setBusy(null);
    }
  };

  /** A clip takes a few seconds. Record first, watch it, then save or share on the next click. */
  const record = async () => {
    if (!canRecordVideo()) {
      setNote("This browser can't record video. Picture works.");
      return;
    }
    setBusy("clip");
    setNote(null);
    setPlay((n) => n + 1);
    try {
      const made = await recordClip(sketch, market, streak, style);
      setClip({ ...made, url: URL.createObjectURL(made.blob) });
    } catch {
      setNote("The recording didn't take. Try once more, or save a picture.");
    } finally {
      setBusy(null);
    }
  };

  const clipName = clip ? `skech-${market.symbol.toLowerCase()}-round.${clip.ext}` : "";
  const shareClip = async () => {
    if (!clip) return;
    try {
      if (canShareFile(clip.blob, clipName)) {
        await navigator.share({ files: [new File([clip.blob], clipName, { type: clip.blob.type })], text });
        say("Shared");
      } else {
        saveBlob(clip.blob, clipName);
        say("Saved");
      }
    } catch (e) {
      if ((e as DOMException).name !== "AbortError") {
        saveBlob(clip.blob, clipName);
        say("Saved");
      }
    }
  };

  /**
   * X takes no file from a page without an app key: open the compose tab first (inside the click,
   * or it is blocked), then put the picture on the clipboard, or save a held clip.
   */
  const postOnX = async () => {
    window.open(xPostUrl(text), "_blank", "noopener");
    if (clip) {
      saveBlob(clip.blob, clipName);
      setNote("The post is open in a new tab. The clip is saved, drag it in.");
      return;
    }
    const ok = await copyPicture(exportPng(sketch, market, streak, style));
    setNote(ok ? "The post is open in a new tab. The picture is on your clipboard, paste it in." : "The post is open in a new tab. Save the picture and drop it in.");
  };

  return (
    <div className="flex flex-col gap-5 px-6 pb-6 pt-2 sm:px-7">
      <div>
        <p className="text-sm text-muted-foreground">Latest result · {market.name}</p>
        <p className={cn("mt-2 text-5xl font-semibold tracking-[-0.045em] tabular-nums", sketch.net >= 0 ? "text-up" : "text-down")}>{signedUsd(sketch.net)}</p>
        <p className="mt-2 text-sm text-muted-foreground">{outcomeLabel(sketch.outcome)}</p>
      </div>
      {/* The card is the whole story: what you see here is what gets posted. */}
      <div className="overflow-hidden rounded-2xl bg-background/60">
        {!sketch.run?.length ? (
          <p className="p-6 text-sm text-muted-foreground">Chart replay wasn’t saved for this round. The result comes from venue fills.</p>
        ) : clip ? (
          <ClipPlayer src={clip.url} />
        ) : (
          <RoundCanvas chartOnly={!studio} style={style} market={market} play={play} sketch={sketch} streak={streak} />
        )}
      </div>

      <Button className="self-start" disabled={!sketch.run?.length || !sketch.pts.length} onClick={() => setStudio(!studio)} variant="outline" aria-expanded={studio}>
        <Share2Icon /> {studio ? "Close card studio" : "Make it yours"}
      </Button>
      {studio ? (
        <div className="space-y-4 rounded-2xl border bg-muted/30 p-4">
          <div>
            <p className="text-sm font-medium">Your share card</p>
            <p className="mt-1 text-xs text-muted-foreground">{sketch.author ? `Made by ${sketch.author}` : "Guest prediction · set a display name after signing in."}</p>
          </div>
          <fieldset disabled={busy !== null || clip !== null} className="space-y-3 disabled:opacity-60">
            <legend className="sr-only">Card appearance</legend>
            <div className="flex flex-wrap items-center gap-2">
              <span className="mr-auto text-xs text-muted-foreground">Background</span>
              {(["night", "paper"] as const).map((theme) => (
                <Button key={theme} size="sm" variant={style.theme === theme ? "default" : "outline"} aria-pressed={style.theme === theme} onClick={() => setStyle((s) => ({ ...s, theme }))}>
                  {theme === "night" ? "Midnight" : "Paper"}
                </Button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="mr-auto text-xs text-muted-foreground">Sketch buddy</span>
              {(["blue", "mint", "coral"] as const).map((buddy) => (
                <Button key={buddy} size="sm" variant={style.buddy === buddy ? "default" : "outline"} aria-pressed={style.buddy === buddy} onClick={() => setStyle((s) => ({ ...s, buddy }))}>
                  {buddy[0].toUpperCase() + buddy.slice(1)}
                </Button>
              ))}
            </div>
            <label className="flex items-center justify-between text-xs">
              <span>Include money amounts</span>
              <input type="checkbox" checked={style.showMoney} onChange={(e) => setStyle((s) => ({ ...s, showMoney: e.target.checked }))} className="size-4 accent-primary" />
            </label>
          </fieldset>
          {busy === "clip" ? <p role="status" className="text-xs text-muted-foreground">Making your replay… prediction, market, then result.</p> : <p className="text-xs text-muted-foreground">Preview above. Save a picture or make an animated clip below.</p>}
        </div>
      ) : null}
      <dl className="grid grid-cols-3 gap-3 text-sm">
        <div>
          <dt className="text-xs text-muted-foreground">Size</dt>
          <dd className="mt-1 font-medium tabular-nums">${usd(sketch.stake, 0)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Boost</dt>
          <dd className="mt-1 font-medium tabular-nums">{sketch.leverage}×</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Return</dt>
          <dd className="mt-1 font-medium tabular-nums">{sketch.stake > 0 ? `${sketch.net >= 0 ? "+" : ""}${((sketch.net / sketch.stake) * 100).toFixed(2)}%` : "—"}</dd>
        </div>
      </dl>
      {onNext ? (
        <Button className="h-12 w-full rounded-full sm:h-12" onClick={onNext}>
          New trade
        </Button>
      ) : null}

      {note ? <p className="text-muted-foreground text-xs">{note}</p> : null}

      {clip ? (
        <div className="flex flex-wrap items-center justify-center gap-1">
          <span className="mr-1 text-muted-foreground text-xs">Your clip, {clip.ext === "mp4" ? "MP4" : "WebM"}.</span>
          <Button disabled={!sketch.run?.length || !sketch.pts.length} aria-label="Post on X" onClick={postOnX} size="sm" variant="ghost">
            <XMark />
            Post
          </Button>
          <Button onClick={() => saveBlob(clip.blob, clipName)} size="sm" variant="ghost">
            <DownloadIcon />
            Save clip
          </Button>
          {canShareFile(clip.blob, clipName) ? (
            <Button onClick={shareClip} size="sm" variant="ghost">
              {done ? <CheckIcon /> : <Share2Icon />}
              {done ?? "Share"}
            </Button>
          ) : null}
          <Button
            onClick={() => {
              URL.revokeObjectURL(clip.url);
              setClip(null);
            }}
            size="sm"
            variant="ghost"
          >
            Back to the chart
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-4 gap-2 [&>button]:h-10 [&>button]:rounded-full [&>button]:min-w-0 [&>button]:px-1 [&>button]:text-xs">
          <Button disabled={!sketch.run?.length || !sketch.pts.length} aria-label="Post on X" onClick={postOnX} size="sm" variant="outline">
            <XMark />
            Post
          </Button>
          <Button disabled={busy === "clip" || !sketch.run?.length || !sketch.pts.length} onClick={() => setPlay((n) => n + 1)} size="sm" variant="outline">
            <PlayIcon />
            Replay
          </Button>
          <Button disabled={busy !== null || !sketch.run?.length || !sketch.pts.length} loading={busy === "png"} onClick={picture} size="sm" variant="outline">
            {done ? <CheckIcon /> : <DownloadIcon />}
            {done ?? "Picture"}
          </Button>
          <Button disabled={busy !== null || !sketch.run?.length || !sketch.pts.length} loading={busy === "clip"} onClick={record} size="sm" variant="outline">
            <FilmIcon />
            Clip
          </Button>
        </div>
      )}
    </div>
  );
}

/** Compact history keeps the result scannable on both desktop and phone. */
function SketchList({ sketches, market }: { sketches: Sketch[]; market: Market }) {
  const settled = sketches.filter((s) => s.status === "settled" && s.pnlReady !== false);
  const total = settled.reduce((sum, s) => sum + s.net, 0);
  if (!sketches.length) {
    return (
      <Empty className="py-8">
        <EmptyHeader>
          <EmptyDescription>Nothing drawn yet.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <section className="px-6 py-6 sm:px-7" aria-label="Round history">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold">Recent rounds</h3>
        <span className="text-xs text-muted-foreground">{sketches.length} rounds</span>
      </div>
      <div className="divide-y divide-border/50">
        {sketches.map((s) => (
          <div key={s.id} className="flex items-center gap-3 py-4">
            <SketchThumb className="h-9 w-14 shrink-0 border-0 bg-muted/30" sketch={s} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{market.name}<span className="ml-2 text-xs font-normal text-muted-foreground">{s.leverage}×</span></p>
              <p className="mt-1 text-xs text-muted-foreground tabular-nums">${usd(s.stake, 0)} · {new Date(s.placedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</p>
              <p className="mt-1 text-[11px] text-muted-foreground tabular-nums">${fmtPrice(s.entry)} → {s.exit === undefined ? (s.status === "settled" ? "Closed" : "Open") : `$${fmtPrice(s.exit)}`}</p>
            </div>
            <span className={cn("shrink-0 text-sm font-medium tabular-nums", s.net >= 0 ? "text-up" : "text-down")}>{s.status === "running" ? "Live" : s.pnlReady === false ? "Unreconciled" : signedUsd(s.net)}</span>
          </div>
        ))}
      </div>
      {settled.length ? (
        <div className="mt-2 flex items-center justify-between rounded-xl bg-muted/40 px-4 py-3 text-sm">
          <span className="text-muted-foreground">Total result</span>
          <span className={cn("font-semibold tabular-nums", total >= 0 ? "text-up" : "text-down")}>{signedUsd(total)}</span>
        </div>
      ) : null}
    </section>
  );
}

export function RoundsSheet({
  social,
  open,
  onOpenChange,
  sketches,
  market,
  onNext,
}: {
  social: PlayerState;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sketches: Sketch[];
  market: Market;
  onNext?: () => void;
}) {
  const settled = sketches.filter((s) => s.status === "settled");
  const latest = settled[0];
  const streak = streakOf(sketches);
  return (
    <Sheet onOpenChange={(next, details) => {
      // Market ticks and a release on the chart must not dismiss the result.
      // Keep sharing open until the close button, Escape, or New trade.
      if (!next && details.reason !== "close-press" && details.reason !== "escape-key") {
        details.cancel();
        return;
      }
      onOpenChange(next);
    }} open={open}>
      <SheetPopup className="bg-popover sm:max-w-lg" side="right" variant="inset">
        <SheetHeader className="px-6 pt-7 pb-4 sm:px-7">
          <SheetTitle className="text-lg font-semibold tracking-tight">Rounds</SheetTitle>
        </SheetHeader>
        <SheetPanel className="p-0">
          {latest ? (
            <div className="border-b">
              {latest.pnlReady === false ? (
                <div className="space-y-4 px-6 pb-6">
                  <p className="font-medium">Position closed</p>
                  <p className="text-sm text-muted-foreground">The original round’s fill history is incomplete. Its P&L is unavailable and excluded from the total.</p>
                  {onNext ? (
                    <Button className="w-full" onClick={onNext}>
                      New trade
                    </Button>
                  ) : null}
                </div>
              ) : (
                <RoundCard buddy={social.player?.buddy} key={latest.id} market={market} onNext={onNext} sketch={latest} streak={streak} />
              )}
            </div>
          ) : null}
          <PlayerCard social={social} />
          <SketchList market={market} sketches={sketches} />
        </SheetPanel>
      </SheetPopup>
    </Sheet>
  );
}
