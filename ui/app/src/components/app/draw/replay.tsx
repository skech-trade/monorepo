"use client";

import { useEffect, useState } from "react";
import { type Candle, type Market, signedUsd, usd } from "@/lib/market";
import { legPath, lineAt, type Pt, verdictWord } from "@/lib/sketch";
import { type Palette, readPalette } from "@/lib/theme";
import { HANDLE } from "@/lib/user";
import { cn } from "@/lib/utils";
import type { Sketch } from "./sketches";

/**
 * A round, played back. Everything a round was is kept on the sketch: the
 * line, the candles that arrived, which minutes paid. This draws them again,
 * on screen as an SVG and off screen onto a canvas for a picture or a clip.
 * Nothing leaves the browser.
 */

/**
 * Where each thing sits inside a W by H box, for both painters. The time
 * axis runs from the start to wherever the line or the candles got, whichever
 * is further, so a short line or an early exit fills the box instead of
 * leaving the right half empty.
 */
function layout(sketch: Sketch, W: number, H: number, pad: { t: number; b: number; l: number; r: number }) {
  const run = sketch.run ?? [];
  const runBars = sketch.runBars ?? Math.max(1, run.length);
  const line = sketch.curve ?? sketch.pts;
  const end = Math.max(line[line.length - 1]?.t ?? 1, run.length / runBars);
  const span = Math.min(1, Math.max(0.15, end));
  const prices = [...line.map((p) => p.price), ...run.flatMap((c) => [c.h, c.l]), sketch.entry];
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  const padP = (hi - lo || sketch.entry * 0.01) * 0.12;
  const innerW = W - pad.l - pad.r;
  const y = (p: number) => pad.t + ((hi + padP - p) / (hi - lo + padP * 2)) * (H - pad.t - pad.b);
  const x = (t: number) => pad.l + (t / span) * innerW;
  const step = innerW / (runBars * span);
  return { run, runBars, line, y, x, step, span, minutes: Math.round(runBars * span) };
}

/** How much the line made in a minute: the line's direction times the candle's move. */
function paid(line: Pt[], entry: number, runBars: number, i: number, c: Candle): boolean {
  const prices = sampled(line, entry);
  const was = lineAt(prices, i / runBars);
  const goes = lineAt(prices, (i + 1) / runBars);
  return (goes >= was ? 1 : -1) * (c.c - c.o) >= 0;
}

/** The line as SAMPLES-ish prices, without importing the whole model. */
function sampled(line: Pt[], entry: number): number[] {
  const n = 32;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    let v = line[line.length - 1]?.price ?? entry;
    if (t <= (line[0]?.t ?? 0)) v = line[0]?.price ?? entry;
    else
      for (let k = 0; k < line.length - 1; k++) {
        if (t <= line[k + 1].t) {
          const u = (t - line[k].t) / (line[k + 1].t - line[k].t || 1);
          v = line[k].price + (line[k + 1].price - line[k].price) * u;
          break;
        }
      }
    out.push(v);
  }
  out[0] = entry;
  return out;
}

/* ---- the words --------------------------------------------------------------- */

/** A run of text, set in the sans or in figures. */
export type Seg = { text: string; mono?: boolean };

const WORDS = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

/** What happened, in one sentence, after "you drew Bitcoin down, $100 at 10×." */
export function whatHappened(sketch: Sketch): Seg[] {
  const pct = Math.round((sketch.right ?? sketch.accuracy ?? 0) * 100);
  switch (sketch.outcome) {
    case "target":
      return sketch.net >= 0 ? [{ text: "It got where the line said." }] : [{ text: "It got there, but the move was smaller than the fees." }];
    case "floor":
      return [{ text: "It hit the floor first." }];
    case "liquidated":
      return [{ text: "It ran the other way and took the whole stake." }];
    case "closed":
      return [{ text: "Taken off early, " }, { text: `${pct}%`, mono: true }, { text: " of the way." }];
    default:
      return [{ text: "It stayed with the line " }, { text: `${pct}%`, mono: true }, { text: " of the way." }];
  }
}

/** The sentence under the money on the card. Third person: it is for other people. */
export function cardStory(sketch: Sketch, market: Market): Seg[] {
  return [
    { text: `${HANDLE} drew ${market.name} ${sketch.long ? "up" : "down"}, ` },
    { text: `$${usd(sketch.stake, 0)}`, mono: true },
    { text: " at " },
    { text: `${sketch.leverage}×`, mono: true },
    { text: ". " },
    ...whatHappened(sketch),
  ];
}

/** The sentence beside the money in the app. Second person: it is yours. */
export function roundStory(sketch: Sketch, market: Market, round: number, streak: number): Seg[] {
  const out: Seg[] = [
    { text: `You drew ${market.name} ${sketch.long ? "up" : "down"}, ` },
    { text: `$${usd(sketch.stake, 0)}`, mono: true },
    { text: " at " },
    { text: `${sketch.leverage}×`, mono: true },
    { text: ". " },
    ...whatHappened(sketch),
  ];
  if (streak >= 2) {
    const n = streak < WORDS.length ? WORDS[streak][0].toUpperCase() + WORDS[streak].slice(1) : String(streak);
    out.push({ text: ` ${n} in a row.` });
  }
  out.push({ text: ` Round ${round}.` });
  return out;
}

/** What goes in the post. First person, since you are the one posting it. */
export function postText(sketch: Sketch, market: Market): string {
  const word = verdictWord(sketch.outcome ?? "time", sketch.right ?? sketch.accuracy ?? 0, sketch.net);
  const happened = whatHappened(sketch)
    .map((s) => s.text)
    .join("");
  return `${word}. Drew ${market.name} ${sketch.long ? "up" : "down"} on skech, $${usd(sketch.stake, 0)} at ${sketch.leverage}×. ${happened} ${signedUsd(sketch.net)}.\n\nskech.trade`;
}

/** X's compose window, prefilled. Text only: X takes no file by link, so the picture rides the clipboard. */
export function xPostUrl(text: string): string {
  return `https://x.com/intent/post?text=${encodeURIComponent(text)}`;
}

/* ---- on screen ---------------------------------------------------------------- */

/**
 * The round on screen. `frame` is how far through the playback it is, 0 to 1;
 * pass `play` to run it from the start over a few seconds.
 */
export function ReplayChart({ sketch, play = 0, className }: { sketch: Sketch; play?: number; className?: string }) {
  const [frame, setFrame] = useState(1);
  useEffect(() => {
    if (!play) return;
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const f = Math.min(1, (now - start) / 3200);
      setFrame(f);
      if (f < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [play]);

  const W = 480;
  const H = 200;
  const { run, runBars, line, y, x, step, minutes } = layout(sketch, W, H, { t: 12, b: 18, l: 8, r: 8 });
  const shown = Math.round(frame * run.length);
  const plotted = line.map((p) => ({ x: x(p.t), y: y(p.price) }));
  const path = legPath(plotted);
  const prices = sampled(line, sketch.entry);

  return (
    <svg aria-label="The round, played back" className={cn("block w-full", className)} viewBox={`0 0 ${W} ${H}`}>
      <line stroke="var(--muted-foreground)" strokeDasharray="3 4" strokeOpacity="0.5" x1={0} x2={W} y1={y(sketch.entry)} y2={y(sketch.entry)} />
      {run.slice(0, shown).map((c, i) => {
        const good = paid(line, sketch.entry, runBars, i, c);
        const cx = x((i + 0.5) / runBars);
        const body = Math.max(2, step * 0.6);
        const tone = c.c >= c.o ? "var(--up-mark)" : "var(--down-mark)";
        const top = y(Math.max(c.o, c.c));
        const bottom = y(Math.min(c.o, c.c));
        const at = y(lineAt(prices, (i + 1) / runBars));
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional
          <g key={i}>
            <rect fill={good ? "var(--success)" : "var(--destructive)"} fillOpacity="0.22" height={14} width={step} x={x(i / runBars)} y={at - 7} />
            <line stroke={tone} strokeWidth="1" x1={cx} x2={cx} y1={y(c.h)} y2={y(c.l)} />
            <rect fill={tone} height={Math.max(1, bottom - top)} width={body} x={cx - body / 2} y={top} />
          </g>
        );
      })}
      <path d={path} fill="none" stroke="var(--brand)" strokeDasharray="5 4" strokeLinecap="round" strokeLinejoin="round" strokeOpacity="0.85" strokeWidth="2" />
      {sketch.pts.slice(1).map((p, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: positional
        <circle cx={x(p.t)} cy={y(p.price)} fill="var(--card)" key={i} r="3" stroke="var(--brand)" strokeWidth="1.5" />
      ))}
      <text fill="var(--muted-foreground)" fontSize="10" style={{ fontFamily: "var(--font-sans)" }} x={8} y={H - 5}>
        start
      </text>
      <text fill="var(--muted-foreground)" fontSize="10" style={{ fontFamily: "var(--font-sans)" }} textAnchor="end" x={W - 8} y={H - 5}>
        +{minutes}m
      </text>
    </svg>
  );
}

/* ---- the card ------------------------------------------------------------------ */

/** 16:9, the size a post plays a video at. The picture is the last frame. */
export const CARD = { W: 1280, H: 720, M: 64 };

/**
 * What the card is painted with: the theme as it is on screen right now, the
 * page's own fonts, and the mark. Read once per export, since fonts and images
 * are async and a frame painter cannot wait.
 */
export type Look = { p: Palette; sans: string; mono: string; mark: HTMLCanvasElement | null };

async function markTile(color: string): Promise<HTMLCanvasElement | null> {
  try {
    const img = new Image();
    img.src = "/assets/logo-mark-alpha.webp";
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0);
    ctx.globalCompositeOperation = "source-in";
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, c.width, c.height);
    return c;
  } catch {
    return null;
  }
}

export async function prepareLook(): Promise<Look> {
  const p = readPalette();
  const style = getComputedStyle(document.documentElement);
  const sans = `${style.getPropertyValue("--font-sans").trim() || "Inter"}, ui-sans-serif, system-ui, sans-serif`;
  const mono = `${style.getPropertyValue("--font-mono").trim() || "ui-monospace"}, ui-monospace, SFMono-Regular, monospace`;
  try {
    await Promise.all([document.fonts.load(`600 32px ${sans}`), document.fonts.load(`400 24px ${sans}`), document.fonts.load(`600 72px ${mono}`), document.fonts.ready]);
  } catch {
    // The system face will do.
  }
  return { p, sans, mono, mark: await markTile(p.fg) };
}

/** Text in runs: words in the sans, figures in the mono. Returns the width. */
function runs(ctx: CanvasRenderingContext2D, segs: Seg[], x: number, y: number, size: number, look: Look, color: string, measureOnly = false): number {
  let dx = 0;
  for (const s of segs) {
    ctx.font = s.mono ? `500 ${size}px ${look.mono}` : `400 ${size}px ${look.sans}`;
    if (!measureOnly) {
      ctx.fillStyle = color;
      ctx.fillText(s.text, x + dx, y);
    }
    dx += ctx.measureText(s.text).width;
  }
  return dx;
}

/** Break runs into lines no wider than `max`, at spaces. */
function wrap(ctx: CanvasRenderingContext2D, segs: Seg[], size: number, look: Look, max: number): Seg[][] {
  const lines: Seg[][] = [[]];
  let width = 0;
  for (const s of segs) {
    const words = s.text.split(/(?<= )/);
    for (const w of words) {
      const piece = { text: w, mono: s.mono };
      const wPx = runs(ctx, [piece], 0, 0, size, look, "", true);
      if (width + wPx > max && lines[lines.length - 1].length > 0) {
        lines.push([]);
        width = 0;
      }
      const line = lines[lines.length - 1];
      const last = line[line.length - 1];
      if (last && last.mono === piece.mono) last.text += piece.text;
      else line.push(piece);
      width += wPx;
    }
  }
  return lines;
}

/** The house curve, for the one thing on the card that moves on its own. */
const ease = (u: number) => 1 - (1 - u) ** 4;

/**
 * Paint one frame of the round. `frame` runs 0 to 1: first the line draws
 * itself, then the candles arrive against it, then the money lands. A picture
 * is frame 1; a clip is every frame in turn. The chart is the whole card;
 * the words sit along its foot.
 */
export function paintRound(ctx: CanvasRenderingContext2D, sketch: Sketch, market: Market, frame: number, look: Look) {
  const { W, H, M } = CARD;
  const { p } = look;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = p.bg;
  ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";

  // The words along the foot, measured first so the chart knows its floor.
  const won = sketch.net >= 0;
  const money = signedUsd(sketch.net);
  const story = cardStory(sketch, market);
  ctx.font = `400 22px ${look.sans}`;
  const tag = "Draw yours at skech.trade";
  const tagW = ctx.measureText(tag).width;
  const storyLines = wrap(ctx, story, 24, look, W - 2 * M - tagW - 48);
  const storyH = storyLines.length * 32;
  const footTop = H - M - storyH - 96;

  // The mark and the name, top left. Nothing else up there.
  if (look.mark) ctx.drawImage(look.mark, M, M - 6, 36, 30);
  ctx.fillStyle = p.fg;
  ctx.font = `600 30px ${look.sans}`;
  ctx.fillText("skech", M + (look.mark ? 48 : 0), M + 18);

  // The chart, the width of the card.
  const box = { x: M, y: M + 64, w: W - 2 * M, h: footTop - (M + 64) - 24 };
  const { run, runBars, line, y, x, step } = layout(sketch, box.w, box.h, { t: 16, b: 16, l: 0, r: 24 });
  const X = (t: number) => box.x + x(t);
  const Y = (v: number) => box.y + y(v);

  // Four hairlines, as the app's chart has, and the entry as a dotted one.
  ctx.strokeStyle = p.grid;
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const gy = Math.round(box.y + (box.h * i) / 4) + 0.5;
    ctx.beginPath();
    ctx.moveTo(box.x, gy);
    ctx.lineTo(box.x + box.w, gy);
    ctx.stroke();
  }
  ctx.strokeStyle = p.fgMuted;
  ctx.globalAlpha = 0.5;
  ctx.setLineDash([3, 6]);
  ctx.beginPath();
  ctx.moveTo(box.x, Y(sketch.entry));
  ctx.lineTo(box.x + box.w, Y(sketch.entry));
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;

  // Phases of the frame.
  const drawn = Math.min(1, frame / 0.2);
  const arrived = Math.max(0, Math.min(1, (frame - 0.2) / 0.68));
  const landed = Math.max(0, Math.min(1, (frame - 0.88) / 0.12));

  // The candles, each against the minute of the line it was judged by.
  const shown = Math.round(arrived * run.length);
  const prices = sampled(line, sketch.entry);
  for (let i = 0; i < shown; i++) {
    const c = run[i];
    const good = paid(line, sketch.entry, runBars, i, c);
    ctx.fillStyle = good ? p.upSoft : p.downSoft;
    ctx.fillRect(X(i / runBars), Y(lineAt(prices, (i + 1) / runBars)) - 9, step, 18);
    const cx = X((i + 0.5) / runBars);
    const col = c.c >= c.o ? p.upMark : p.downMark;
    ctx.strokeStyle = col;
    ctx.fillStyle = col;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, Y(c.h));
    ctx.lineTo(cx, Y(c.l));
    ctx.stroke();
    const body = Math.max(4, Math.min(step * 0.62, 26));
    const top = Y(Math.max(c.o, c.c));
    ctx.fillRect(cx - body / 2, top, body, Math.max(2, Y(Math.min(c.o, c.c)) - top));
  }

  // The line, drawn as a pen draws it: from the start, by length.
  const pts = line.map((q) => ({ x: X(q.t), y: Y(q.price) }));
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  let budget = total * ease(drawn);
  ctx.strokeStyle = p.brand;
  ctx.lineWidth = 5;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length && budget > 0; i++) {
    const seg = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    if (seg <= budget) {
      ctx.lineTo(pts[i].x, pts[i].y);
      budget -= seg;
    } else {
      const u = budget / seg;
      ctx.lineTo(pts[i - 1].x + (pts[i].x - pts[i - 1].x) * u, pts[i - 1].y + (pts[i].y - pts[i - 1].y) * u);
      budget = 0;
    }
  }
  ctx.stroke();

  // The money and the sentence, once it is over.
  if (landed > 0) {
    const k = ease(landed);
    ctx.globalAlpha = k;
    const rise = (1 - k) * 12;
    ctx.fillStyle = won ? p.up : p.down;
    ctx.font = `600 76px ${look.mono}`;
    ctx.fillText(money, M, footTop + 76 + rise);
    storyLines.forEach((segs, i) => runs(ctx, segs, M, footTop + 76 + 44 + i * 32 + rise, 24, look, p.fg));
    ctx.globalAlpha = 1;
  }
  ctx.fillStyle = p.fgMuted;
  ctx.font = `400 22px ${look.sans}`;
  ctx.textAlign = "right";
  ctx.fillText(tag, W - M, H - M);
  ctx.textAlign = "left";
}

function card(): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement("canvas");
  canvas.width = CARD.W;
  canvas.height = CARD.H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no canvas");
  return { canvas, ctx };
}

/** The round as a picture. */
export async function exportPng(sketch: Sketch, market: Market): Promise<Blob> {
  const look = await prepareLook();
  const { canvas, ctx } = card();
  paintRound(ctx, sketch, market, 1, look);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("no blob"))), "image/png"));
}

export type Clip = { blob: Blob; ext: "mp4" | "webm" };

/** The container the browser can actually write. MP4 travels better; Safari has no WebM. */
function clipMime(): { mime: string; ext: Clip["ext"] } | null {
  if (typeof MediaRecorder === "undefined") return null;
  const tries: { mime: string; ext: Clip["ext"] }[] = [
    { mime: "video/mp4;codecs=avc1.42E01E", ext: "mp4" },
    { mime: "video/mp4;codecs=avc1", ext: "mp4" },
    { mime: "video/mp4", ext: "mp4" },
    { mime: "video/webm;codecs=vp9", ext: "webm" },
    { mime: "video/webm;codecs=vp8", ext: "webm" },
    { mime: "video/webm", ext: "webm" },
  ];
  return tries.find((t) => MediaRecorder.isTypeSupported(t.mime)) ?? null;
}

/** True when this browser can record a clip at all. */
export function canRecordClip(): boolean {
  return typeof HTMLCanvasElement !== "undefined" && "captureStream" in HTMLCanvasElement.prototype && clipMime() !== null;
}

/**
 * The round as a clip: the line draws itself, the candles arrive, the money
 * lands, over a few seconds, recorded off a canvas. The canvas sits in the
 * document while it records, out of sight, because some browsers only hand
 * frames to the stream for a canvas that is attached.
 */
export async function recordClip(sketch: Sketch, market: Market, seconds = 5): Promise<Clip> {
  const picked = clipMime();
  if (!picked || !("captureStream" in HTMLCanvasElement.prototype)) throw new Error("unsupported");
  const look = await prepareLook();
  const { canvas, ctx } = card();
  canvas.style.cssText = "position:fixed;left:-10000px;top:0;width:1px;height:1px;opacity:0;pointer-events:none";
  document.body.appendChild(canvas);
  try {
    paintRound(ctx, sketch, market, 0, look);
    const stream = canvas.captureStream(30);
    const rec = new MediaRecorder(stream, { mimeType: picked.mime, videoBitsPerSecond: 5_000_000 });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    const done = new Promise<Blob>((resolve, reject) => {
      rec.onstop = () => resolve(new Blob(chunks, { type: picked.mime }));
      rec.onerror = () => reject(new Error("recorder"));
    });
    rec.start(200);
    const start = performance.now();
    await new Promise<void>((resolve) => {
      const tick = (now: number) => {
        const f = Math.min(1, (now - start) / (seconds * 1000));
        paintRound(ctx, sketch, market, f, look);
        if (f < 1) requestAnimationFrame(tick);
        else setTimeout(resolve, 1200);
      };
      requestAnimationFrame(tick);
    });
    rec.stop();
    for (const track of stream.getTracks()) track.stop();
    const blob = await done;
    if (blob.size === 0) throw new Error("empty");
    return { blob, ext: picked.ext };
  } finally {
    canvas.remove();
  }
}

/* ---- handing it over ------------------------------------------------------------ */

/** Save a file the way a download does. Needs no permission and no fresh click. */
export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 4000);
}

/** Whether the share sheet would take this file, right now, from this click. */
export function canShareFile(blob: Blob, filename: string): boolean {
  if (typeof navigator === "undefined" || typeof navigator.share !== "function" || typeof navigator.canShare !== "function") return false;
  try {
    return navigator.canShare({ files: [new File([blob], filename, { type: blob.type })] });
  } catch {
    return false;
  }
}

/**
 * Put a picture on the clipboard, so it pastes into a post. Takes the promise
 * rather than the blob, because the clipboard has to be asked inside the click
 * and painting the picture takes a moment. False where the clipboard will not
 * take images.
 */
export async function copyPicture(png: Promise<Blob>): Promise<boolean> {
  if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) return false;
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Hand a file to the share sheet where there is one, else save it. The share
 * sheet only opens off a fresh click, so call this straight from one; anything
 * that takes a while (a recording) has to finish first and be handed over on
 * the next click.
 */
export async function shareOrSave(blob: Blob, filename: string, text: string): Promise<"shared" | "saved"> {
  const fresh = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation?.isActive ?? true;
  if (fresh && canShareFile(blob, filename)) {
    try {
      await navigator.share({ files: [new File([blob], filename, { type: blob.type })], text });
      return "shared";
    } catch (e) {
      // Closed the sheet: leave it. Anything else: fall through and save.
      if ((e as DOMException).name === "AbortError") throw e;
    }
  }
  saveBlob(blob, filename);
  return "saved";
}
