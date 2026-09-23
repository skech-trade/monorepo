"use client";

import { useEffect, useRef, useState } from "react";
import { type Market, signedUsd } from "@/lib/market";
import { type Clip, recordCanvas } from "@/lib/share";
import { type Palette, readPalette, subscribePalette } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { cardStory, type Seg } from "./round-copy";
import { BUDDY_COLORS, DEFAULT_SHARE_STYLE, paintBuddy, type ShareStyle } from "./share-style";
import type { Sketch } from "./sketches";

/**
 * The card a round becomes: one painter for the canvas on screen, the picture
 * and the clip, so the three always agree. Nothing leaves the browser.
 */

/** 16:9, the size a post plays a video at. The picture is the last frame. */
export const CARD = { W: 1280, H: 720, M: 64 };

/** The card animates in three beats: the line draws, the candles arrive, the money lands. */
const BEATS = { drawn: 0.2, arrived: 0.88 };

/** Clip length in seconds. */
const CLIP_SECONDS = 5;

/** Theme colours as painted, the page's fonts and the mark. Read once per export; a frame painter cannot await. */
type Look = { p: Palette; sans: string; mono: string; mark: HTMLCanvasElement | null };

/** The mark, tinted, as a canvas the painter can blit. */
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

async function prepareLook(): Promise<Look> {
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

/**
 * Where everything sits in a W by H box. The time axis runs to wherever the
 * line or the candles got, whichever is further, so an early exit does not
 * leave the right half empty.
 */
function layout(sketch: Sketch, W: number, H: number, pad: { t: number; b: number; l: number; r: number }) {
  const run = sketch.run ?? [];
  const runBars = sketch.runBars ?? Math.max(1, run.length);
  const line = sketch.pts;
  const end = Math.max(line[line.length - 1]?.t ?? 1, run.length / runBars);
  const span = Math.min(1, Math.max(0.15, end));
  const all = [...line.map((p) => p.price), ...run.flatMap((c) => [c.h, c.l]), sketch.entry];
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const padP = (hi - lo || sketch.entry * 0.01) * 0.12;
  const innerW = W - pad.l - pad.r;
  const y = (p: number) => pad.t + ((hi + padP - p) / (hi - lo + padP * 2)) * (H - pad.t - pad.b);
  const x = (t: number) => pad.l + (t / span) * innerW;
  const step = innerW / (runBars * span);
  return { run, runBars, line, y, x, step };
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
    for (const w of s.text.split(/(?<= )/)) {
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

/** The house curve. */
const ease = (u: number) => 1 - (1 - u) ** 4;

/**
 * Paint one frame, `frame` running 0 to 1. A picture is frame 1; a clip is
 * every frame in turn. The chart is the whole card; the money, the sentence,
 * the mark and the address sit along its foot. The top corners stay empty
 * because X puts its own controls there on a video.
 */
function paintRound(ctx: CanvasRenderingContext2D, sketch: Sketch, market: Market, frame: number, look: Look, streak = 0, chartOnly = false, style: ShareStyle = DEFAULT_SHARE_STYLE) {
  const { W, M } = CARD;
  const H = ctx.canvas.height;
  const p = chartOnly ? look.p : { ...look.p,
    bg: style.theme === "night" ? "#121110" : "#fbfaf9",
    fg: style.theme === "night" ? "#fafaf9" : "#343433",
    fgMuted: style.theme === "night" ? "#b3ada6" : "#5f5c59",
    grid: style.theme === "night" ? "#292724" : "#e9e6e1",
    up: style.theme === "night" ? "#4ade80" : "#15803d",
    down: style.theme === "night" ? "#fb7185" : "#c4291d",
    brand: style.theme === "night" ? "#8fb0ff" : "#2b62de",
  };
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = p.bg;
  ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";

  if (!chartOnly) {
    ctx.fillStyle = p.fgMuted;
    ctx.font = `500 22px ${look.sans}`;
    ctx.fillText("SKECH / PREDICTION REPLAY", M, 36);
    ctx.textAlign = "right";
    ctx.fillText("Unverified result", W - M, 36);
    ctx.textAlign = "left";
  }
  // The foot is measured first so the chart knows its floor.
  const won = sketch.net >= 0;
  const money = style.showMoney ? signedUsd(sketch.net) : "My prediction";
  ctx.font = `400 22px ${look.sans}`;
  const tag = "Draw yours at skech.trade";
  const tagW = ctx.measureText(tag).width;
  const story = style.showMoney
    ? cardStory(sketch, market, streak)
    : [{ text: `${sketch.author || "A skecher"} drew ${market.name}. The line was the prediction. The candles tell the story.` }];
  const storyLines = wrap(ctx, story, 24, look, W - 2 * M - tagW - 88);
  const footTop = chartOnly ? H - M + 24 : H - M - storyLines.length * 32 - 96;

  const box = { x: M, y: M, w: W - 2 * M, h: footTop - M - 24 };
  const { run, runBars, line, y, x, step } = layout(sketch, box.w, box.h, { t: 16, b: 16, l: 0, r: 24 });
  const X = (t: number) => box.x + x(t);
  const Y = (v: number) => box.y + y(v);

  // Four hairlines, as the app's chart has, and the entry dotted.
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

  const drawn = Math.min(1, frame / BEATS.drawn);
  const arrived = Math.max(0, Math.min(1, (frame - BEATS.drawn) / (BEATS.arrived - BEATS.drawn)));
  const landed = Math.max(0, Math.min(1, (frame - BEATS.arrived) / (1 - BEATS.arrived)));

  // Candles, each shaded by whether that second paid, the same rule the chart and the score use.
  const shown = Math.round(arrived * run.length);
  for (let i = 0; i < shown; i++) {
    const c = run[i];

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
  if (pts.length) ctx.moveTo(pts[0].x, pts[0].y);
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

  if (chartOnly) return;

  paintBuddy(ctx, W - M - 72, footTop + 62, BUDDY_COLORS[style.buddy], sketch.net >= 0, frame);

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
  if (look.mark) ctx.drawImage(look.mark, W - M - tagW - 40, H - M - 21, 26, 22);
  ctx.textAlign = "left";
}

function blankCard(): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement("canvas");
  canvas.width = CARD.W;
  canvas.height = CARD.H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no canvas");
  return { canvas, ctx };
}

/** The round as a picture. */
export async function exportPng(sketch: Sketch, market: Market, streak = 0, style: ShareStyle = DEFAULT_SHARE_STYLE): Promise<Blob> {
  const look = await prepareLook();
  const { canvas, ctx } = blankCard();
  paintRound(ctx, sketch, market, 1, look, streak, false, style);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("no blob"))), "image/png"));
}

/** The round as a clip. */
export async function recordClip(sketch: Sketch, market: Market, streak = 0, style: ShareStyle = DEFAULT_SHARE_STYLE): Promise<Clip> {
  const look = await prepareLook();
  const { canvas, ctx } = blankCard();
  return recordCanvas(canvas, (f) => paintRound(ctx, sketch, market, f, look, streak, false, style), CLIP_SECONDS);
}

/**
 * The card on screen, painted by the same hand as the picture and the clip.
 * Bump `play` to run the animation from the start; a theme change repaints
 * the finished frame in place.
 */
export function RoundCanvas({ sketch, market, streak = 0, play = 0, chartOnly = false, style = DEFAULT_SHARE_STYLE, className }: { sketch: Sketch; market: Market; streak?: number; play?: number; chartOnly?: boolean; style?: ShareStyle; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [look, setLook] = useState<Look | null>(null);
  const [theme, setTheme] = useState(0);
  useEffect(() => subscribePalette(() => setTheme((n) => n + 1)), []);
  useEffect(() => {
    let live = true;
    prepareLook().then((l) => live && setLook(l));
    return () => {
      live = false;
    };
  }, [theme]);
  const played = useRef(0);
  useEffect(() => {
    const ctx = ref.current?.getContext("2d");
    if (!ctx || !look) return;
    if (!play || played.current === play) {
      paintRound(ctx, sketch, market, 1, look, streak, chartOnly, style);
      return;
    }
    played.current = play;
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const f = Math.min(1, (now - start) / (CLIP_SECONDS * 1000));
      paintRound(ctx, sketch, market, f, look, streak, chartOnly, style);
      if (f < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [look, play, sketch, market, streak, chartOnly, style]);
  return <canvas aria-label={chartOnly ? "Prediction compared with market prices" : "The round, as the card that gets posted"} className={cn("block w-full", className)} height={chartOnly ? 440 : CARD.H} ref={ref} width={CARD.W} />;
}
