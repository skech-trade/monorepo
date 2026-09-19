"use client";

import { CheckIcon, DownloadIcon, FilmIcon, PlayIcon, Share2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader } from "@/components/ui/empty";
import { Sheet, SheetDescription, SheetHeader, SheetPanel, SheetPopup, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { type Candle, type Market, price as fmtPrice, signedUsd, usd } from "@/lib/market";
import { legPath, type Outcome, type Pt, verdictWord } from "@/lib/sketch";
import { cn } from "@/lib/utils";
import { canRecordClip, canShareFile, type Clip, copyPicture, exportPng, postText, recordClip, ReplayChart, roundStory, saveBlob, type Seg, shareOrSave, xPostUrl } from "./replay";

/** A sketch is a position you can look at. The list keeps the drawing. */
export type Sketch = {
  id: string;
  long: boolean;
  stake: number;
  leverage: number;
  entry: number;
  pts: Pt[];
  placedAt: number;
  status: "running" | "settled";
  net: number;
  exit?: number;
  liquidated?: boolean;
  /** Share of the move that went your way. Over a half means it profited. */
  accuracy?: number;
  /** The round, kept: what arrived, how long it was, how it ended. */
  run?: Candle[];
  runBars?: number;
  outcome?: Outcome | "closed";
  right?: number;
  /** The line the model traded: the handles, or the curve through them. */
  curve?: Pt[];
};

export function SketchThumb({ sketch, className }: { sketch: Sketch; className?: string }) {
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
export function streakOf(sketches: Sketch[]): number {
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

/** A sentence in runs: words in the sans, figures in the mono. */
function Story({ segs }: { segs: Seg[] }) {
  return (
    <>
      {segs.map((s, i) =>
        s.mono ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional
          <span className="figures text-foreground" key={i}>
            {s.text}
          </span>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  );
}

/**
 * The latest round, as a card: the money, one sentence saying what happened,
 * a replay you can run again, and the picture or clip to send. This is where
 * a round ends now, in the same place every earlier round is listed, rather
 * than in a dialog over the chart.
 */
export function RoundCard({ sketch, market, round, streak, onNext }: { sketch: Sketch; market: Market; round: number; streak: number; onNext?: () => void }) {
  const [play, setPlay] = useState(1);
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
  const won = sketch.net >= 0;
  const right = sketch.right ?? sketch.accuracy ?? 0;
  const word = verdictWord(sketch.outcome ?? "time", right, sketch.net);
  const text = postText(sketch, market);

  const say = (w: string) => {
    setDone(w);
    setTimeout(() => setDone(null), 1800);
  };

  /** A picture is quick, so it goes straight to the share sheet or a download off this click. */
  const picture = async () => {
    setBusy("png");
    setNote(null);
    try {
      const blob = await exportPng(sketch, market);
      say((await shareOrSave(blob, `skech-round-${round}.png`, text)) === "shared" ? "Shared" : "Saved");
    } catch (e) {
      if ((e as DOMException).name !== "AbortError") setNote("Couldn't make the picture here.");
    } finally {
      setBusy(null);
    }
  };

  /** A clip takes a few seconds. Record first, watch it, then save or share on the next click. */
  const record = async () => {
    if (!canRecordClip()) {
      setNote("This browser can't record video. Picture works.");
      return;
    }
    setBusy("clip");
    setNote(null);
    setPlay((n) => n + 1);
    try {
      const made = await recordClip(sketch, market);
      setClip({ ...made, url: URL.createObjectURL(made.blob) });
    } catch {
      setNote("The recording didn't take. Try once more, or save a picture.");
    } finally {
      setBusy(null);
    }
  };

  const clipName = clip ? `skech-round-${round}.${clip.ext}` : "";
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
   * X has no way to take a file from a page without an app key, so the post
   * opens prefilled with the words and the picture goes on the clipboard in
   * the same click, to paste in. A clip is saved instead, to drag in. The
   * tab has to open first, inside the click, or the browser blocks it.
   */
  const postOnX = async () => {
    window.open(xPostUrl(text), "_blank", "noopener");
    if (clip) {
      saveBlob(clip.blob, clipName);
      setNote("The post is open in a new tab. The clip is saved, drag it in.");
      return;
    }
    const ok = await copyPicture(exportPng(sketch, market));
    setNote(ok ? "The post is open in a new tab. The picture is on your clipboard, paste it in." : "The post is open in a new tab. Save the picture and drop it in.");
  };

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* One figure leads. Everything else about the round is a sentence beside it. */}
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className={cn("figures font-semibold text-3xl leading-none", won ? "text-up" : "text-down")}>{signedUsd(sketch.net)}</span>
        <p className="min-w-0 flex-1 basis-64 text-muted-foreground text-sm leading-snug">
          <span className="font-medium text-foreground">{word}.</span> <Story segs={roundStory(sketch, market, round, streak)} />
        </p>
      </div>

      <div className="overflow-hidden rounded-xl border bg-muted/30">
        {clip ? (
          // biome-ignore lint/a11y/useMediaCaption: a silent clip of the chart above
          <video autoPlay className="block aspect-video w-full bg-background" controls loop muted playsInline src={clip.url} />
        ) : sketch.run && sketch.run.length > 0 ? (
          <ReplayChart play={play} sketch={sketch} />
        ) : (
          <SketchThumb className="h-40 w-full" sketch={sketch} />
        )}
      </div>

      {note ? <p className="text-muted-foreground text-xs">{note}</p> : null}

      {clip ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-1 text-muted-foreground text-xs">Your clip, {clip.ext === "mp4" ? "MP4" : "WebM"}.</span>
          <Button onClick={postOnX} size="sm">
            <XMark />
            Post on X
          </Button>
          <Button onClick={() => saveBlob(clip.blob, clipName)} size="sm" variant="outline">
            <DownloadIcon />
            Save clip
          </Button>
          {canShareFile(clip.blob, clipName) ? (
            <Button onClick={shareClip} size="sm" variant="outline">
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
          {onNext ? (
            <Button className="ml-auto" onClick={onNext} size="sm" variant="ghost">
              New trade
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={postOnX} size="sm">
            <XMark />
            Post on X
          </Button>
          <Button disabled={busy === "clip"} onClick={() => setPlay((n) => n + 1)} size="sm" variant="outline">
            <PlayIcon />
            Replay
          </Button>
          <Button disabled={busy !== null} loading={busy === "png"} onClick={picture} size="sm" variant="outline">
            {done ? <CheckIcon /> : <DownloadIcon />}
            {done ?? "Picture"}
          </Button>
          <Button disabled={busy !== null} loading={busy === "clip"} onClick={record} size="sm" variant="outline">
            <FilmIcon />
            Clip
          </Button>
          {onNext ? (
            <Button className="ml-auto" onClick={onNext} size="sm" variant="ghost">
              New trade
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** What became of a line, in as few words as it takes. */
function Outcome({ sketch }: { sketch: Sketch }) {
  if (sketch.status === "running") {
    return (
      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
        <span className="size-1.5 animate-pulse rounded-full bg-info" />
        playing out
      </span>
    );
  }
  if (sketch.liquidated) return <span className="text-warning-foreground">wiped out</span>;
  if (sketch.accuracy === undefined) return <span className="text-muted-foreground">{sketch.net >= 0 ? "called it" : "missed"}</span>;
  return <span className="figures text-muted-foreground">right {Math.round(sketch.accuracy * 100)}%</span>;
}

/**
 * The same table the desk keeps its positions in.
 *
 * A line is a position, so it is listed like one: a row per line, columns that
 * line up, figures right-aligned in the tabular face, the seams hairlines. It
 * was a stack of free-floating cards with the numbers stacked two-deep inside
 * each — nothing to read down, nothing to compare, and a column of air beneath.
 *
 * No side column. The drawing in the first cell is the side: a line that ends
 * above where it started is up, and you can see that faster than you can read
 * the word for it. A pill saying so as well was the same fact twice, in the
 * widest possible form, in a list whose whole point is the shapes.
 */
export function SketchList({ sketches }: { sketches: Sketch[] }) {
  if (sketches.length === 0) {
    return (
      <Empty className="py-8 md:py-8">
        <EmptyHeader>
          <EmptyDescription>Nothing drawn yet.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <Table className="text-xs">
      <TableHeader>
        <TableRow>
          <TableHead className="pl-3">Line</TableHead>
          <TableHead>Size</TableHead>
          <TableHead>In at</TableHead>
          <TableHead>Out at</TableHead>
          <TableHead className="pr-3 text-right">Result</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sketches.map((s) => (
          <TableRow key={s.id}>
            <TableCell className="pl-3">
              <SketchThumb className="h-7 w-12 shrink-0" sketch={s} />
            </TableCell>
            <TableCell className="figures whitespace-nowrap">
              ${usd(s.stake, 0)} <span className="text-muted-foreground">at {s.leverage}×</span>
            </TableCell>
            <TableCell className="figures whitespace-nowrap">${fmtPrice(s.entry)}</TableCell>
            <TableCell className="figures whitespace-nowrap">
              {s.exit === undefined ? <span className="text-muted-foreground">&mdash;</span> : `$${fmtPrice(s.exit)}`}
            </TableCell>
            <TableCell className="whitespace-nowrap pr-3 text-right">
              <span className={cn("figures font-medium", s.net >= 0 ? "text-up" : "text-down")}>{signedUsd(s.net)}</span>
              <span className="ml-2">
                <Outcome sketch={s} />
              </span>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function RoundsSheet({
  open,
  onOpenChange,
  sketches,
  market,
  onNext,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sketches: Sketch[];
  market: Market;
  onNext?: () => void;
}) {
  const total = sketches.reduce((sum, s) => sum + s.net, 0);
  const settled = sketches.filter((s) => s.status === "settled");
  const won = settled.filter((s) => s.net >= 0).length;
  const latest = settled[0];
  const streak = streakOf(sketches);
  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetPopup className="sm:max-w-2xl" side="right" variant="inset">
        <SheetHeader>
          <SheetTitle>Rounds</SheetTitle>
          <SheetDescription>
            {settled.length === 0 ? (
              "Nothing has settled yet. Your first round lands here."
            ) : (
              <>
                <span className="figures text-foreground">{won}</span> of <span className="figures text-foreground">{settled.length}</span> came good today. {total >= 0 ? "Up" : "Down"}{" "}
                <span className={cn("figures", total >= 0 ? "text-up" : "text-down")}>${usd(Math.abs(total))}</span> on {market.name}.
              </>
            )}
          </SheetDescription>
        </SheetHeader>
        <SheetPanel className="p-0">
          {latest ? (
            <div className="border-b">
              <RoundCard market={market} onNext={onNext} round={settled.length} sketch={latest} streak={streak} />
            </div>
          ) : null}
          <SketchList sketches={sketches} />
        </SheetPanel>
      </SheetPopup>
    </Sheet>
  );
}

/** Two lines from earlier, so the list is reviewable. Mock, like every figure here. */
export function seedSketches(market: Market): Sketch[] {
  const e1 = market.price * 0.994;
  const e2 = market.price * 1.003;
  const shape = (entry: number, ms: number[]): Pt[] => ms.map((m, i) => ({ t: i / (ms.length - 1), price: entry * m }));
  return [
    { id: "seed-1", long: true, stake: 100, leverage: 5, entry: e1, pts: shape(e1, [1, 0.996, 0.992, 0.995, 1.002, 1.008, 1.012, 1.016]), placedAt: Date.now() - 3 * 3_600_000, status: "settled", net: 23.4, exit: e1 * 1.0047, accuracy: 0.83 },
    { id: "seed-2", long: false, stake: 50, leverage: 10, entry: e2, pts: shape(e2, [1, 1.003, 0.998, 0.993, 0.99, 0.986, 0.985]), placedAt: Date.now() - 55 * 60_000, status: "settled", net: -17.9, exit: e2 * 1.0036, accuracy: 0.38 },
  ];
}
