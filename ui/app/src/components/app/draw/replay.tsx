"use client";

import { useEffect, useState } from "react";
import { type Candle, type Market, price as fmtPrice, signedUsd, usd } from "@/lib/market";
import { legPath, lineAt, type Pt, smoothPath, verdictWord } from "@/lib/sketch";
import { cn } from "@/lib/utils";
import type { Sketch } from "./sketches";

/**
 * A round, played back. Everything a round was is kept on the sketch: the
 * line, the candles that arrived, which minutes paid. This draws them again,
 * on screen as an SVG and off screen onto a canvas for a picture or a clip.
 * Nothing leaves the browser.
 */

/** Where each thing sits inside a W by H box, for both painters. */
function layout(sketch: Sketch, W: number, H: number, pad: { t: number; b: number; l: number; r: number }) {
  const run = sketch.run ?? [];
  const runBars = sketch.runBars ?? Math.max(1, run.length);
  const line = sketch.curve ?? sketch.pts;
  const prices = [...line.map((p) => p.price), ...run.flatMap((c) => [c.h, c.l]), sketch.entry];
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  const padP = (hi - lo || sketch.entry * 0.01) * 0.12;
  const y = (p: number) => pad.t + ((hi + padP - p) / (hi - lo + padP * 2)) * (H - pad.t - pad.b);
  const x = (t: number) => pad.l + t * (W - pad.l - pad.r);
  const step = (W - pad.l - pad.r) / runBars;
  return { run, runBars, line, y, x, step };
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
  const { run, runBars, line, y, x, step } = layout(sketch, W, H, { t: 12, b: 18, l: 8, r: 8 });
  const shown = Math.round(frame * run.length);
  const plotted = line.map((p) => ({ x: x(p.t), y: y(p.price) }));
  const path = sketch.smooth ? smoothPath(plotted) : legPath(plotted);

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
        const prices = sampled(line, sketch.entry);
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
        +{Math.round(runBars)}m
      </text>
    </svg>
  );
}

/* ---- the picture ----------------------------------------------------------- */

const CARD = { W: 1200, H: 630 };

/** The colours the card is painted in. Its own, so it looks the same everywhere. */
const INK = {
  bg: "#0e0e0e",
  panel: "#161616",
  fg: "#fafafa",
  muted: "#8a8a8a",
  line: "#8fb0ff",
  up: "#34d399",
  down: "#f87171",
  grid: "#242424",
};

/**
 * Paint one frame of the round onto a canvas, as the card people share.
 * `frame` is how many candles have arrived, 0 to 1. A picture is frame 1; a
 * clip is every frame in turn.
 */
export function paintRound(ctx: CanvasRenderingContext2D, sketch: Sketch, market: Market, frame: number) {
  const { W, H } = CARD;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = INK.bg;
  ctx.fillRect(0, 0, W, H);

  const word = verdictWord(sketch.outcome ?? "time", sketch.right ?? 0, sketch.net);
  const won = sketch.net >= 0;
  const tone = sketch.liquidated ? INK.down : (sketch.right ?? 0) >= 0.7 ? INK.up : (sketch.right ?? 0) >= 0.5 ? INK.fg : INK.down;

  // Header: the mark of the product and the market.
  ctx.fillStyle = INK.fg;
  ctx.font = "600 30px Inter, ui-sans-serif, system-ui, sans-serif";
  ctx.textBaseline = "alphabetic";
  ctx.fillText("skech", 56, 78);
  ctx.fillStyle = INK.muted;
  ctx.font = "500 24px Inter, ui-sans-serif, system-ui, sans-serif";
  ctx.textAlign = "right";
  ctx.fillText(`${market.name} ${sketch.long ? "up" : "down"} · $${usd(sketch.stake, 0)} at ${sketch.leverage}×`, W - 56, 78);
  ctx.textAlign = "left";

  // The verdict and the money.
  ctx.fillStyle = tone;
  ctx.font = "700 64px Inter, ui-sans-serif, system-ui, sans-serif";
  ctx.fillText(word, 56, 170);
  const wordWidth = ctx.measureText(word).width;
  ctx.fillStyle = won ? INK.up : INK.down;
  ctx.font = '600 52px "Geist Mono", ui-monospace, SFMono-Regular, monospace';
  ctx.fillText(signedUsd(sketch.net), 56 + wordWidth + 36, 168);
  ctx.fillStyle = INK.muted;
  ctx.font = "400 24px Inter, ui-sans-serif, system-ui, sans-serif";
  const right = Math.round((sketch.right ?? 0) * 100);
  ctx.fillText(`Right ${right}% of the way. In at $${fmtPrice(sketch.entry)}${sketch.exit !== undefined ? `, out at $${fmtPrice(sketch.exit)}` : ""}.`, 56, 212);

  // The chart.
  const box = { x: 56, y: 250, w: W - 112, h: 300 };
  ctx.fillStyle = INK.panel;
  roundRect(ctx, box.x, box.y, box.w, box.h, 20);
  ctx.fill();
  const { run, runBars, line, y, x, step } = layout(sketch, box.w, box.h, { t: 24, b: 28, l: 20, r: 20 });
  const X = (t: number) => box.x + x(t);
  const Y = (p: number) => box.y + y(p);
  ctx.strokeStyle = INK.grid;
  ctx.setLineDash([4, 6]);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(box.x + 20, Y(sketch.entry));
  ctx.lineTo(box.x + box.w - 20, Y(sketch.entry));
  ctx.stroke();
  ctx.setLineDash([]);

  const shown = Math.round(frame * run.length);
  const prices = sampled(line, sketch.entry);
  const barW = step * (box.w - 40) / (box.w - 40);
  for (let i = 0; i < shown; i++) {
    const c = run[i];
    const good = paid(line, sketch.entry, runBars, i, c);
    ctx.fillStyle = good ? INK.up : INK.down;
    ctx.globalAlpha = 0.22;
    ctx.fillRect(X(i / runBars), Y(lineAt(prices, (i + 1) / runBars)) - 10, barW, 20);
    ctx.globalAlpha = 1;
    const cx = X((i + 0.5) / runBars);
    const col = c.c >= c.o ? INK.up : INK.down;
    ctx.strokeStyle = col;
    ctx.fillStyle = col;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx, Y(c.h));
    ctx.lineTo(cx, Y(c.l));
    ctx.stroke();
    const body = Math.max(3, barW * 0.6);
    const top = Y(Math.max(c.o, c.c));
    ctx.fillRect(cx - body / 2, top, body, Math.max(2, Y(Math.min(c.o, c.c)) - top));
  }

  // The line, dashed, over it all.
  ctx.strokeStyle = INK.line;
  ctx.lineWidth = 3;
  ctx.setLineDash([8, 6]);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  const pts = line.map((p) => ({ x: X(p.t), y: Y(p.price) }));
  if (sketch.smooth && pts.length > 2) {
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] ?? pts[i];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[i + 2] ?? p2;
      ctx.bezierCurveTo(p1.x + (p2.x - p0.x) / 6, p1.y + (p2.y - p0.y) / 6, p2.x - (p3.x - p1.x) / 6, p2.y - (p3.y - p1.y) / 6, p2.x, p2.y);
    }
  } else {
    pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  }
  ctx.stroke();
  ctx.setLineDash([]);

  // Every minute, green where it paid, along the foot of the card.
  const flags = run.slice(0, shown).map((c, i) => paid(line, sketch.entry, runBars, i, c));
  const stripY = H - 44;
  const stripW = (W - 112) / Math.max(1, run.length);
  run.forEach((_, i) => {
    ctx.fillStyle = i < flags.length ? (flags[i] ? INK.up : INK.down) : INK.grid;
    ctx.globalAlpha = i < flags.length ? 0.85 : 1;
    roundRect(ctx, 56 + i * stripW + 1, stripY, Math.max(2, stripW - 2), 12, 3);
    ctx.fill();
  });
  ctx.globalAlpha = 1;
  ctx.fillStyle = INK.muted;
  ctx.font = "400 18px Inter, ui-sans-serif, system-ui, sans-serif";
  ctx.textAlign = "right";
  ctx.fillText("skech.trade", W - 56, H - 16);
  ctx.textAlign = "left";
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
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
  const { canvas, ctx } = card();
  paintRound(ctx, sketch, market, 1);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("no blob"))), "image/png"));
}

/** The round as a clip: the candles arrive over a few seconds. WebM, recorded from the canvas. */
export async function recordWebm(sketch: Sketch, market: Market, seconds = 4): Promise<Blob> {
  const { canvas, ctx } = card();
  const stream = canvas.captureStream(30);
  const mime = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m)) ?? "video/webm";
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 4_000_000 });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const done = new Promise<Blob>((resolve) => {
    rec.onstop = () => resolve(new Blob(chunks, { type: mime }));
  });
  rec.start();
  const start = performance.now();
  await new Promise<void>((resolve) => {
    const tick = (now: number) => {
      const f = Math.min(1, (now - start) / (seconds * 1000));
      paintRound(ctx, sketch, market, f);
      if (f < 1) requestAnimationFrame(tick);
      else setTimeout(resolve, 700);
    };
    requestAnimationFrame(tick);
  });
  rec.stop();
  return done;
}

/** Hand a file to the share sheet where there is one, else save it. */
export async function shareOrSave(blob: Blob, filename: string, text: string): Promise<"shared" | "saved"> {
  const file = new File([blob], filename, { type: blob.type });
  if (typeof navigator.share === "function" && navigator.canShare?.({ files: [file] })) {
    await navigator.share({ files: [file], text });
    return "shared";
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return "saved";
}
