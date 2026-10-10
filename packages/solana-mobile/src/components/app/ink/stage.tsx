import { BlendMode, Canvas, ClipOp, matchFont, PaintStyle, Picture, Skia, StrokeCap, StrokeJoin, TileMode, type SkCanvas, type SkFont, type SkPaint, type SkPath, type SkPicture } from "@shopify/react-native-skia";
import { grouped } from "@/lib/money";
import { memo, type RefObject, useEffect, useMemo, useRef } from "react";
import { AppState, type LayoutChangeEvent, Platform, View } from "react-native";
import { Gesture, GestureDetector, State } from "react-native-gesture-handler";
import { useReducedMotion, useSharedValue } from "react-native-reanimated";
import { type Bar, type Field, openFor } from "@skech/core/dots";
import { type BetCell, CHART_STEP_PX, type Cell, drawingLayout, INK_CELL, type InkBet, type Pen, PEN_CELLS, type Stroke, VIEW_SECONDS } from "@skech/core/ink";
import { roundedTerms as areaTerms } from "@skech/core/odds";
import type { Tick } from "@/lib/engine";
import { feel, pen as penSound } from "@/lib/feel";
import { tracePricePath } from "./price-path";
import { avatarSeedOf, playerHue, type PublicDrawing, socialMoney } from "@skech/core/social";
import { dylanXml } from "@/lib/avatar";
import { livePens, type LivePen, penFlush, penLift, remoteDrawings, visibleSocialDrawings } from "@/lib/social";

/**
 * The stage: the price so far on the left, now in the middle, and the space ahead of it to draw in. The web's
 * canvas (ui/app/src/components/app/ink/stage.tsx), drawn with Skia: the same map of soft tiles, each with the
 * multiple a tap there pays; the same ink, solid where it is in play, faint where it is not, green where the price
 * has been through it; the same price line, pen and bursts. One picture a frame, recorded from a game object the
 * screen mutates, since sixty frames a second of moving ink is not a job for React. The screen owns the rules and
 * the money; this owns the picture and the pen. The pen is a finger: a pan that starts the moment it lands.
 */

/**
 * Something that happened on the chart, drawn where it happened. `profit`: a hit in a round that is ahead, which
 * sprays; a hit while the round is still behind only rings. `burst`: a round that came out ahead, its confetti thrown
 * (by the screen's own canvas, `Game.burst`) from where the price last met its ink, as much as its `tier` earns.
 */
export type Fx = { kind: "hit" | "miss" | "placed" | "drop" | "burst"; t: number; price: number; born: number; text?: string; loss?: boolean; line?: string; big?: boolean; profit?: boolean; tier?: number; thrown?: boolean; piece?: string };
/**
 * Ink that was in play and is not any more, because the chain did not take it (refused, voided, never answered, or
 * given back): it fades out over `GONE_MS` from where it was, rather than vanishing; the web's `Gone`. `whole`:
 * nothing else of its drawing is left, so its faint line fades too; otherwise the line stays, faint there.
 */
export type Gone = { stroke: Stroke; cells: Cell[]; edgeCells: number; step: number; born: number; whole: boolean };
export const GONE_MS = 300;
export type Preview = { multipleLow: number; multipleHigh: number; units: number; cost: number; low: number; high: number; inPlay: Cell[]; out: Cell[]; keyboard?: boolean };

export type Game = {
  bars: Bar[];
  ticks: Tick[];
  skew: number;
  field: Field | null;
  placeLead: number;
  step: number;
  priceStep: number;
  marketStep: number;
  viewport: { width: number; height: number };
  displayPrice: number;
  perDot: number;
  pen: Pen;
  cell: number;
  drawing?: { step: number; priceStep: number; perDot: number; pen: Pen };
  bets: InkBet[];
  quote: ((st: Stroke) => Preview | null) | null;
  fx: Fx[];
  /** Ink fading out, newest last: see `Gone`. */
  gone?: Gone[];
  dark: boolean;
  /** Throws a profitable round's confetti from (x, y) on the stage, on the UI thread. */
  burst?: (x: number, y: number, tier: number) => void;
};

const now = (g: Game) => Date.now() + g.skew;
const price = (g: Game) => g.ticks.at(-1)?.p ?? g.bars.at(-1)?.c ?? 0;

type Rgb = [number, number, number];
type Palette = { ink: Rgb; fg: Rgb; bg: Rgb; muted: Rgb; faint: Rgb; up: Rgb; down: Rgb; dark: boolean };
const hex = (h: string): Rgb => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
/** The app's own shades, as `src/global.css` has them. */
const PALETTES: Record<"light" | "dark", Palette> = {
  light: { ink: hex("#2e5bff"), fg: hex("#000000"), bg: hex("#ffffff"), muted: hex("#6c6c70"), faint: hex("#aeaeb2"), up: hex("#34c759"), down: hex("#ff3b30"), dark: false },
  dark: { ink: hex("#6f92ff"), fg: hex("#ffffff"), bg: hex("#000000"), muted: hex("#98989f"), faint: hex("#636366"), up: hex("#30d158"), down: hex("#ff453a"), dark: true },
};
/*
  Colours, text widths and a font's metrics are asked for hundreds of times a frame, each a string parsed or a call
  across to native; on a cheap phone that alone was most of a frame. Kept once made. Alpha in hundredths, so a fade
  makes a hundred colours, not one a frame.
*/
/** A frame costing more than this on the JS thread marks a slow phone; there the stage draws at half rate while the pen is up. */
const SLOW_FRAME_MS = 6;
const HALF_RATE_MS = 30;
const colors = new Map<string, ReturnType<typeof Skia.Color>>();
const color = (c: Rgb, a = 1) => {
  const k = `${c[0]},${c[1]},${c[2]},${Math.round(a * 100) / 100}`;
  let v = colors.get(k);
  if (!v) {
    if (colors.size > 5000) colors.clear();
    colors.set(k, (v = Skia.Color(`rgba(${k})`)));
  }
  return v;
};
/** A player's colour, as the web's `hsl(hue, 55%, light%)`: worked out once a player. */
const hues = new Map<string, Rgb>();
const hueRgb = (player: string, light: number): Rgb => {
  const k = `${player}:${light}`;
  let v = hues.get(k);
  if (!v) {
    if (hues.size > 1000) hues.clear();
    const h = playerHue(player) / 360, s = 0.55, l = light / 100;
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    const ch = (t: number) => {
      t = (t + 1) % 1;
      return Math.round(255 * (t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p));
    };
    hues.set(k, (v = [ch(h + 1 / 3), ch(h), ch(h - 1 / 3)]));
  }
  return v;
};
/**
 * Faces on the chart: each player's Dylan avatar drawn once from its SVG into a small image of its own, and that
 * image copied each frame. Never the SVG itself per frame.
 */
const faces = new Map<string, ReturnType<typeof Skia.Image.MakeImageFromEncoded> | null>();
const faceImage = (seed: string) => {
  if (faces.has(seed)) return faces.get(seed)!;
  if (faces.size > 120) faces.clear();
  let image = null;
  try {
    const svg = Skia.SVG.MakeFromString(dylanXml(seed));
    const surface = Skia.Surface.Make(64, 64);
    if (svg && surface) {
      surface.getCanvas().drawSvg(svg, 64, 64);
      image = surface.makeImageSnapshot();
    }
  } catch {
    image = null;
  }
  faces.set(seed, image);
  return image;
};
const mix = (a: Rgb, b: Rgb, k: number): Rgb => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k].map(Math.round) as Rgb;
/** How far up the ladder a multiple is, 0 at 1× to 1 at 128×. */
const height = (m: number) => Math.min(1, Math.max(0, Math.log2(m) / 7));

/** Show the maximum return per section, rounded down to a tenth. */
export const fmtMultiple = (m: number) => `${Math.floor(m * 10 + 1e-8) / 10}×`;
const fmtPrice = (p: number, cents: boolean) => grouped(p, cents ? 2 : 0);

export type Placed = string | { stop: string } | null;
const whyOf = (r: Placed) => (r && typeof r === "object" ? r.stop : r);

/* ---- drawing with Skia, the way the web draws with a 2D canvas ---- */

const FAMILY = Platform.select({ ios: "Helvetica Neue", default: "sans-serif" });
const fonts = new Map<string, SkFont>();
const font = (weight: 400 | 500 | 600 | 700, size: number) => {
  const k = `${weight}:${size}`;
  let f = fonts.get(k);
  if (!f) fonts.set(k, (f = matchFont({ fontFamily: FAMILY, fontSize: size, fontWeight: String(weight) as "400" })));
  return f;
};
const fill = Skia.Paint();
fill.setAntiAlias(true);
const line = Skia.Paint();
line.setAntiAlias(true);
line.setStyle(PaintStyle.Stroke);
line.setStrokeCap(StrokeCap.Round);
line.setStrokeJoin(StrokeJoin.Round);
const paintOf = (c: Float32Array, stroke?: number): SkPaint => {
  const p = stroke === undefined ? fill : line;
  p.setColor(c);
  if (stroke !== undefined) p.setStrokeWidth(stroke);
  return p;
};
const rrect = (x: number, y: number, w: number, h: number, r: number) => {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  return Skia.RRectXY(Skia.XYWHRect(x, y, w, h), rr, rr);
};
/** Text centred on `x`, its middle on `y`, as the web's canvas draws with textAlign centre and textBaseline middle. */
const widths = new Map<SkFont, Map<string, number>>();
const middles = new Map<SkFont, number>();
/** How wide `s` is in `f`, measured once. */
function measure(f: SkFont, s: string) {
  let byText = widths.get(f);
  if (!byText) widths.set(f, (byText = new Map()));
  let w = byText.get(s);
  if (w === undefined) {
    if (byText.size > 2000) byText.clear();
    byText.set(s, (w = f.measureText(s).width));
  }
  return w;
}
function text(c: SkCanvas, s: string, x: number, y: number, f: SkFont, col: Float32Array, align: "center" | "left" = "center") {
  const w = measure(f, s);
  let mid = middles.get(f);
  if (mid === undefined) {
    const m = f.getMetrics();
    middles.set(f, (mid = (m.ascent + m.descent) / 2));
  }
  c.drawText(s, align === "center" ? x - w / 2 : x, y - mid, paintOf(col), f);
}
const layerPaint = (alpha = 1, blend?: BlendMode) => {
  const p = Skia.Paint();
  p.setAlphaf(alpha);
  if (blend !== undefined) p.setBlendMode(blend);
  return p;
};
const eraser = (() => {
  const p = Skia.Paint();
  p.setBlendMode(BlendMode.DstOut);
  p.setColor(Skia.Color("black"));
  return p;
})();

/** A blank picture for the first frame: Skia takes no null. */
const EMPTY = (() => {
  const r = Skia.PictureRecorder();
  r.beginRecording(Skia.XYWHRect(0, 0, 1, 1));
  return r.finishRecordingAsPicture();
})();

/*
  Memoised: the screen around it re-renders on every price batch and preview, and the stage draws from refs, not
  props, so it has nothing to do then.
*/
export const Stage = memo(function Stage({
  game,
  onPlace,
  onPreview,
  onViewport,
}: {
  game: RefObject<Game>;
  onPlace: (stroke: Stroke, drawing: string, done: boolean) => Placed;
  onPreview: (p: Preview | null) => void;
  onViewport: (size: { width: number; height: number }) => void;
}) {
  const place = useRef(onPlace);
  const preview = useRef(onPreview);
  const viewport = useRef(onViewport);
  // The phone's Reduce Motion: the picture jumps to where it is going, and nothing bursts or floats.
  const reduced = useReducedMotion();
  const still = useRef(reduced);
  useEffect(() => {
    place.current = onPlace;
    preview.current = onPreview;
    viewport.current = onViewport;
    still.current = reduced;
  });
  const picture = useSharedValue<SkPicture>(EMPTY);
  const size = useRef({ w: 0, h: 0 });
  const handlers = useRef<{ down: (x: number, y: number) => void; move: (x: number, y: number) => void; up: (x: number, y: number) => void; cancel: () => void } | null>(null);

  useEffect(() => {
    /* Geometry. One scale of time for past and future, so the price runs straight into the space you draw in. */
    let centre = 0;
    let at = 0;
    const W = () => size.current.w;
    const H = () => size.current.h;
    const phone = () => W() < 640;
    // Asked for thousands of times a frame (every x(), y(), nowX()…): made again only when what it is made from changes.
    let laid: { w: number; h: number; step: number; it: ReturnType<typeof drawingLayout> } | null = null;
    const layout = () => {
      const w = W(),
        h = H(),
        step = game.current.marketStep;
      if (!laid || laid.w !== w || laid.h !== h || laid.step !== step) laid = { w, h, step, it: drawingLayout(w, h, step) };
      return laid.it;
    };
    const nowX = () => layout().nowX;
    const pxMs = () => layout().pxMs;
    const pitchY = CHART_STEP_PX;
    const plotTop = () => layout().top;
    const plotBottom = () => layout().bottom;
    const middleY = () => (plotTop() + plotBottom()) / 2;
    const NEAR_MS = 4000;
    const pastMs = () => (phone() ? 30_000 : 60_000);
    const farPxMs = () => Math.max(0.0004, (nowX() - 8 - NEAR_MS * pxMs()) / (pastMs() - NEAR_MS));
    const x = (t: number) => {
      const d = at - t;
      return d <= NEAR_MS ? nowX() - d * pxMs() : nowX() - NEAR_MS * pxMs() - (d - NEAR_MS) * farPxMs();
    };
    const tAt = (px: number) => {
      const edge = nowX() - NEAR_MS * pxMs();
      return px >= edge ? at + (px - nowX()) / pxMs() : at - NEAR_MS - (edge - px) / farPxMs();
    };
    const y = (p: number) => middleY() - ((p - centre) / game.current.step) * pitchY;
    const pAt = (py: number) => centre + ((middleY() - py) * game.current.step) / pitchY;
    const radius = () => (PEN_CELLS[game.current.drawing?.pen ?? game.current.pen] * CHART_STEP_PX) / 2;
    const priceRadius = () => (radius() * game.current.step) / pitchY;

    /* The map: a grid of tiles ahead of the wait line, each the multiple a tap at its middle pays. */
    type Tile = { id: string; left: number; width: number; offset: number; p: number; rung: number; text: string; was: string; changed: number; opacity: number };
    const map = { pen: "", width: 0, height: 0, step: 0, field: null as Field | null, tiles: [] as Tile[], rowPx: 36 };
    const gPen = () => game.current.drawing?.pen ?? game.current.pen;
    const WAIT_MS = 2000;
    const waitX = () => nowX() + WAIT_MS * pxMs();
    const inkFrom = () => waitX() + radius();
    const paintMap = (fl: Field) => {
      const w = W();
      map.field = fl;
      map.pen = gPen();
      map.width = w;
      map.height = H();
      map.step = game.current.step;
      const previous = new Map(map.tiles.map((tile) => [tile.id, tile]));
      map.tiles = [];
      const sampledAt = now(game.current);
      const terms = areaTerms(fl, sampledAt + game.current.placeLead, game.current.priceStep, 1);
      const tap = (t: number, p: number) => {
        const q = terms.line({ t0: t, p0: p, pts: [{ t: 0, p: 0 }], rt: radius() / pxMs(), rp: priceRadius() });
        return q.inPlay.length ? Math.max(...q.inPlay.map((c) => c.multiple!)) : 0;
      };
      const gap = 4;
      const pitchX = phone() ? 42 : 88;
      map.rowPx = phone() ? 36 : 46;
      const start = WAIT_MS * pxMs(),
        end = w - nowX() - 6;
      const cols = Math.max(1, Math.floor((end - start + gap) / pitchX));
      const width = (end - start + gap) / cols - gap;
      const rowP = (map.rowPx * game.current.step) / pitchY;
      const kLo = Math.floor(pAt(plotBottom()) / rowP) - 3,
        kHi = Math.ceil(pAt(plotTop()) / rowP) + 3;
      for (let i = 0; i < cols; i++) {
        const left = start + i * (width + gap);
        const offset = (left + width / 2) / pxMs();
        for (let k = kLo; k <= kHi; k++) {
          const p = (k + 0.5) * rowP;
          const rung = tap(sampledAt + offset, p);
          const id = `${i}:${k}`;
          const label = rung ? fmtMultiple(rung) : "";
          const old = previous.get(id);
          const changing = !!old && old.text !== label;
          map.tiles.push({ id, left, width, offset, p, rung, text: label, was: changing ? old!.text : (old?.was ?? label), changed: changing ? performance.now() : (old?.changed ?? 0), opacity: old?.opacity ?? 0 });
        }
      }
    };

    /* The pen: the stroke so far, and what it would cost and pay. */
    type PenState = { drawing: string; last: { x: number; y: number }; stroke: Stroke; quote: Preview | null; quotedAt: number; why: string | null };
    let pen: PenState | null = null;
    let flash: { text: string; x: number; y: number; born: number; ms?: number } | null = null;
    const stopPen = (p: PenState, why: string) => {
      penSound.up();
      pen = null;
      preview.current(null);
      place.current(p.stroke, p.drawing, true);
      game.current.drawing = undefined;
      flash = { text: why, x: p.last.x, y: p.last.y, born: performance.now(), ms: 3200 };
    };
    let penFrom = { x: 0, y: 0, at: 0 };
    const requote = (p: PenState, force = false) => {
      const t = performance.now();
      if (!force && t - p.quotedAt < 50) return;
      p.quotedAt = t;
      p.quote = game.current.quote?.(p.stroke) ?? null;
      preview.current(p.quote);
    };
    const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const down = (qx: number, qy: number) => {
      const g = game.current;
      if (pen || !g || !price(g) || !g.field) return;
      const q = { x: qx, y: qy };
      if (q.y < plotTop() || q.y > plotBottom()) return;
      if (q.x < waitX()) {
        feel("nope");
        flash = { text: "Draw right of the dashed line", x: Math.max(q.x, waitX() + 90), y: q.y, born: performance.now() };
        return;
      }
      feel("tap");
      penSound.down();
      g.fx.push({ kind: "drop", t: tAt(Math.max(q.x, inkFrom())), price: pAt(q.y), born: performance.now() });
      q.x = Math.max(q.x, inkFrom());
      g.drawing = { step: g.step, priceStep: g.priceStep, perDot: g.perDot, pen: g.pen };
      penFrom = { x: q.x, y: q.y, at: performance.now() };
      pen = { drawing: newId(), why: null, last: q, stroke: { t0: tAt(q.x), p0: pAt(q.y), pts: [{ t: 0, p: 0 }], rt: radius() / pxMs(), rp: priceRadius() }, quote: null, quotedAt: 0 };
      requote(pen, true);
      const placed = place.current(pen.stroke, pen.drawing, false);
      if (placed && typeof placed === "object") return stopPen(pen, placed.stop);
      if (placed) pen.why = placed;
    };
    const move = (qx: number, qy: number) => {
      if (!pen) return;
      const target = { x: Math.max(qx, inkFrom()), y: Math.min(plotBottom(), Math.max(plotTop(), qy)) };
      // A light touch of smoothing takes the hand's tremor out without the nib trailing behind.
      const s = { x: pen.last.x + (target.x - pen.last.x) * 0.85, y: pen.last.y + (target.y - pen.last.y) * 0.85 };
      if (pen.stroke.pts.length >= 2048 || Math.hypot(s.x - pen.last.x, s.y - pen.last.y) < 1.5) return;
      pen.last = s;
      pen.stroke.pts.push({ t: tAt(s.x) - pen.stroke.t0, p: pAt(s.y) - pen.stroke.p0 });
      const t = performance.now();
      penSound.move(Math.hypot(s.x - penFrom.x, s.y - penFrom.y) / Math.max(8, t - penFrom.at));
      penFrom = { x: s.x, y: s.y, at: t };
      requote(pen);
      const placed = place.current(pen.stroke, pen.drawing, false);
      if (placed && typeof placed === "object") return stopPen(pen, placed.stop);
      if (placed && placed !== pen.why) {
        pen.why = placed;
        flash = { text: placed, x: s.x, y: s.y, born: performance.now() };
      }
    };
    const up = (qx: number, qy: number) => {
      if (!pen) return;
      penSound.up();
      const p = pen;
      pen = null;
      const q = { x: Math.max(qx, inkFrom()), y: Math.min(plotBottom(), Math.max(plotTop(), qy)) };
      if (Math.hypot(q.x - p.last.x, q.y - p.last.y) > 1.5 && p.stroke.pts.length < 2048) p.stroke.pts.push({ t: tAt(q.x) - p.stroke.t0, p: pAt(q.y) - p.stroke.p0 });
      preview.current(null);
      const why = whyOf(place.current(p.stroke, p.drawing, true));
      game.current.drawing = undefined;
      if (why && why !== p.why) flash = { text: why, x: q.x, y: q.y, born: performance.now() };
    };
    const cancel = () => {
      penSound.up();
      game.current.drawing = undefined;
      pen = null;
      preview.current(null);
    };
    handlers.current = { down, move, up, cancel };

    /* A stroke's path is in its own units, so it is the same every frame: made once, again only as it grows. */
    const strokePaths = new WeakMap<Stroke, { n: number; rt: number; rp: number; path: SkPath }>();
    /*
      Everyone else's ink (lib/social.ts), as on the web: a drawing's pieces joined into one line, made once per
      version of the drawing; lines being drawn right now, made again only when more of them shows.
    */
    type Line = { t0: number; p0: number; rt: number; rp: number; path: SkPath };
    const pathFrom = (pts: readonly { t: number; p: number }[], rt: number, rp: number, n = pts.length) => {
      const path = Skia.Path.Make();
      for (let i = 0; i < n; i++) {
        if (i) path.lineTo(pts[i].t / rt, pts[i].p / rp);
        else path.moveTo(pts[i].t / rt, pts[i].p / rp);
      }
      if (n === 1) path.lineTo(pts[0].t / rt + 1e-3, pts[0].p / rp);
      return path;
    };
    const remoteLines = new WeakMap<PublicDrawing, Line | null>();
    const remoteLine = (d: PublicDrawing): Line | null => {
      let made = remoteLines.get(d);
      if (made !== undefined) return made;
      const pieces = d.pieces.filter((q) => q.stroke?.pts.length && q.stroke.rt && q.stroke.rp).sort((a, b) => (a.from ?? 0) - (b.from ?? 0) || a.openAt - b.openAt);
      const first = pieces[0]?.stroke;
      made = null;
      if (first) {
        const pts: { t: number; p: number }[] = [];
        for (const q of pieces) for (const pt of q.stroke!.pts) if (!pts.length || pt.t !== pts[pts.length - 1].t || pt.p !== pts[pts.length - 1].p) pts.push(pt);
        made = { t0: first.t0, p0: first.p0, rt: first.rt, rp: first.rp, path: pathFrom(pts, first.rt, first.rp) };
      }
      remoteLines.set(d, made);
      return made;
    };
    const penLines = new WeakMap<LivePen, { n: number; path: SkPath }>();
    const penLine = (p: LivePen) => {
      let made = penLines.get(p);
      if (!made || made.n !== p.shown) penLines.set(p, (made = { n: p.shown, path: pathFrom(p.pts, p.rt, p.rp, p.shown) }));
      return made.path;
    };
    const figures = new WeakMap<PublicDrawing, string>();
    /** This player's pen, to everyone else, ten times a second while it is down: nothing runs on a finger's move. */
    let streaming = "";
    const stream = setInterval(() => {
      if (pen) {
        streaming = pen.drawing;
        penFlush(pen.drawing, pen.stroke);
      } else if (streaming) {
        penLift(streaming);
        streaming = "";
      }
    }, 100);
    const pathOf = (st: Stroke) => {
      let made = strokePaths.get(st);
      if (!made || made.n !== st.pts.length || made.rt !== st.rt || made.rp !== st.rp) {
        const path = Skia.Path.Make();
        const pts = st.pts;
        path.moveTo(pts[0].t / st.rt, pts[0].p / st.rp);
        for (let i = 1; i < pts.length - 1; i++) path.lineTo(pts[i].t / st.rt, pts[i].p / st.rp);
        const end = pts[pts.length - 1];
        path.lineTo(end.t / st.rt + (pts.length === 1 ? 1e-3 : 0), end.p / st.rp);
        strokePaths.set(st, (made = { n: pts.length, rt: st.rt, rp: st.rp, path }));
      }
      return made.path;
    };
    /** A stroke, in ink: drawn in its own units, where the pen is round, and scaled onto the screen. */
    const ink = (c: SkCanvas, st: Stroke, col: Float32Array, grow = 0) => {
      const a = st.rt * pxMs();
      const d = (-st.rp * pitchY) / game.current.step;
      const path = pathOf(st);
      c.save();
      c.translate(x(st.t0), y(st.p0));
      c.scale(a, d);
      c.drawPath(path, paintOf(col, 2 + grow));
      c.restore();
    };
    const bandCache = new WeakMap<Cell[], { pad: number; bands: Cell[] }>();
    const clipTo = (c: SkCanvas, rects: { x: number; y: number; w: number; h: number }[]) => {
      const p: SkPath = Skia.Path.Make();
      for (const r of rects) p.addRect(Skia.XYWHRect(r.x, r.y, r.w, r.h));
      c.clipPath(p, ClipOp.Intersect, true);
    };
    const inkInPlay = (c: SkCanvas, st: Stroke, cells: Cell[], col: Float32Array, edgeCells = 0, step = game.current.step) => {
      if (!cells.length) return;
      const pad = edgeCells * step * INK_CELL;
      let cached = bandCache.get(cells);
      if (!cached || cached.pad !== pad) {
        const bands: Cell[] = [];
        for (const q of [...cells].sort((a, b) => a.t - b.t || a.lo - b.lo)) {
          const last = bands.at(-1);
          if (last && last.t === q.t && q.lo - pad <= last.hi) last.hi = Math.max(last.hi, q.hi + pad);
          else bands.push({ ...q, lo: q.lo - pad, hi: q.hi + pad });
        }
        cached = { pad, bands };
        bandCache.set(cells, cached);
      }
      c.save();
      clipTo(c, cached.bands.map((q) => ({ x: x(q.t), y: y(q.hi), w: pxMs() * 1000, h: y(q.lo) - y(q.hi) })));
      ink(c, st, col);
      c.restore();
    };

    let renderedBets: InkBet[] | null = null;
    let renderedGroups: { id: string; stroke: Stroke; cells: Cell[]; edgeCells: number; step: number }[] = [];
    let raf = 0;
    let previousFrame = performance.now();
    // How the stage keeps up, in the log every 5s: frames drawn and what a frame costs on the JS thread.
    const perf = { since: performance.now(), frames: 0, ms: 0, worst: 0 };
    /*
      What a frame has been costing, smoothed. A phone where it costs more than SLOW_FRAME_MS draws at half the rate while
      the pen is up: the chart scrolls a little less smoothly, and the JS thread is free for the pen, the multiples map
      and the money. The pen, when down, always gets every frame.
    */
    let cost = 0;
    let drawnAt = 0;
    /* Nothing is drawn in the background: the loop stops, and a stroke the app was sent away in the middle of is let go. */
    let active = AppState.currentState === "active" || AppState.currentState === null;
    const appState = AppState.addEventListener("change", (state) => {
      active = state === "active";
      if (!active) {
        if (pen) cancel();
        cancelAnimationFrame(raf);
        raf = 0;
      } else if (!raf) {
        previousFrame = performance.now();
        raf = requestAnimationFrame(frame);
      }
    });
    const frame = () => {
      if (!active) {
        raf = 0;
        return;
      }
      raf = requestAnimationFrame(frame);
      const w = W(),
        h = H();
      const g = game.current;
      if (!g || !w) return;
      const t0 = performance.now();
      if (!pen && cost > SLOW_FRAME_MS && t0 - drawnAt < HALF_RATE_MS) return;
      drawnAt = t0;
      const recorder = Skia.PictureRecorder();
      const c = recorder.beginRecording(Skia.XYWHRect(0, 0, w, h));
      draw(c, w, h, g);
      picture.value = recorder.finishRecordingAsPicture();
      const took = performance.now() - t0;
      cost += (took - cost) * 0.1;
      perf.frames++;
      perf.ms += took;
      perf.worst = Math.max(perf.worst, took);
      if (t0 - perf.since >= 5000) {
        const secs = (t0 - perf.since) / 1000;
        console.info(`[perf] stage: ${(perf.frames / secs).toFixed(1)} fps, ${(perf.ms / perf.frames).toFixed(1)}ms a frame (worst ${perf.worst.toFixed(1)}), ${((perf.ms / (secs * 1000)) * 100).toFixed(0)}% of the JS thread`);
        Object.assign(perf, { since: t0, frames: 0, ms: 0, worst: 0 });
      }
    };
    const draw = (c: SkCanvas, w: number, h: number, g: Game) => {
      at = now(g);
      const latest = price(g);
      const ms = performance.now();
      const dt = Math.min(64, Math.max(0, ms - previousFrame));
      previousFrame = ms;
      const ease = (rate: number) => (still.current ? 1 : 1 - Math.exp(-rate * dt));
      const p = latest;
      if (!p) return;
      const pal = g.dark ? PALETTES.dark : PALETTES.light;
      const solid = color(pal.ink, 0.92);
      const green = color(pal.up);
      if (!centre) centre = p;
      const off = (p - centre) / g.step;
      const rowsOnScreen = (plotBottom() - plotTop()) / pitchY;
      // The view follows the price: within ~0.6s when it is near the middle, ~0.2s further out, at once near the edge.
      // (It was ~2.8s near the middle, and the tiles lagged the price for seconds.)
      if (!pen) centre += (p - centre) * ease(Math.abs(off) > rowsOnScreen * 0.3 ? 0.02 : Math.abs(off) > rowsOnScreen * 0.12 ? 0.005 : 0.0016);
      const fl = g.field;
      if (fl && (map.field !== fl || map.pen !== gPen() || map.width !== w || map.height !== h || map.step !== g.step)) paintMap(fl);
      const nx = nowX();

      /* Where the pen is, and the price's own tag: a tile under either is picked out, or kept clear. */
      const tip = pen ? pen.last : null;
      const py = y(p);
      const tagFont = font(600, 12);
      const tagText = fmtPrice(g.displayPrice || latest, true);
      const tagW = measure(tagFont, tagText) + 20;
      const tagX = phone() ? nx - 12 - tagW : nx + 12;
      const tag = { x0: tagX, x1: tagX + tagW, y0: py - 12, y1: py + 12 };
      const tileBox = (tile: Tile) => {
        const ty = y(tile.p);
        return { x0: nx + tile.left, y0: ty - map.rowPx / 2 + 2, w: tile.width, h: map.rowPx - 4 };
      };
      const tiles = fl && map.field === fl ? map.tiles : [];
      for (const tile of tiles) {
        const b = tileBox(tile);
        const onChart = b.y0 >= plotTop() && b.y0 + b.h <= plotBottom();
        const underTag = b.x0 < tag.x1 + 4 && b.x0 + b.w > tag.x0 - 4 && b.y0 < tag.y1 + 4 && b.y0 + b.h > tag.y0 - 4;
        const visible = onChart && tile.rung ? (underTag ? 0.12 : 1) : 0;
        tile.opacity += (visible - tile.opacity) * ease(0.012);
      }
      const underPen = tip
        ? tiles.find((tile) => {
            const b = tileBox(tile);
            return tile.rung && tip.x >= b.x0 - 2 && tip.x <= b.x0 + b.w + 2 && tip.y >= b.y0 - 2 && tip.y <= b.y0 + b.h + 2;
          })
        : undefined;

      // The tiles themselves, under everything: bluer where a hit pays more.
      if (tiles.length) {
        c.save();
        c.clipRect(Skia.XYWHRect(0, plotTop(), w, plotBottom() - plotTop()), ClipOp.Intersect, true);
        const top = pal.dark ? 0.12 : 0.072;
        for (const tile of tiles) {
          if (tile.opacity < 0.01) continue;
          const b = tileBox(tile);
          c.drawRRect(rrect(b.x0, b.y0, b.w, b.h, phone() ? 9 : 12), paintOf(color(pal.ink, top * Math.pow(height(tile.rung), 0.6) * tile.opacity)));
        }
        c.restore();
      }

      // The wait zone, from now to the wait line: greyed out, as nothing can be drawn there.
      {
        const wx = waitX();
        if (wx - nx > 12) c.drawRRect(rrect(nx + 4, plotTop(), wx - nx - 8, plotBottom() - plotTop(), phone() ? 9 : 12), paintOf(color(pal.fg, pal.dark ? 0.07 : 0.045)));
      }

      // The price, live: one line through every trade on hand, and each second's close before them.
      {
        const from = tAt(0);
        const firstTick = g.ticks[0]?.t ?? Number.POSITIVE_INFINITY;
        const pts: { x: number; y: number }[] = [];
        for (const bar of g.bars) {
          if (bar.t >= firstTick) break;
          if (bar.t + 1000 >= from) pts.push({ x: x(bar.t + 1000), y: y(bar.c) });
        }
        let lastX = Number.NEGATIVE_INFINITY;
        for (const tk of g.ticks) {
          if (tk.t < from || tk.t > at) continue;
          const px = x(tk.t);
          if (px - lastX < 0.75 && pts.length) pts[pts.length - 1] = { x: px, y: y(tk.p) };
          else pts.push({ x: px, y: y(tk.p) });
          lastX = px;
        }
        pts.push({ x: nx, y: y(p) });
        if (pts.length > 1) {
          const path = Skia.Path.Make();
          tracePricePath({ moveTo: (a, b) => path.moveTo(a, b), bezierCurveTo: (a, b, cc, d, e, f) => path.cubicTo(a, b, cc, d, e, f) }, pts);
          c.save();
          c.clipRect(Skia.XYWHRect(0, plotTop() - 6, w, plotBottom() - plotTop() + 12), ClipOp.Intersect, true);
          c.drawPath(path, paintOf(color(pal.fg), 2));
          c.restore();
        }
      }

      // Now: a line top to bottom, and the price on it, in a tag of its own.
      const axisY = plotBottom() + 14;
      c.drawRect(Skia.XYWHRect(Math.round(nx) - 0.5, 0, 1, axisY), paintOf(color(pal.fg, 0.16)));
      const pulse = still.current ? 0 : (ms % 1400) / 1400;
      c.drawCircle(nx, py, 10 + pulse * 6, paintOf(color(pal.fg, 0.12 * (1 - pulse * 0.6))));
      c.drawCircle(nx, py, 4.5, paintOf(color(pal.fg)));
      c.drawRRect(rrect(tag.x0, tag.y0, tagW, 24, 12), paintOf(color(pal.fg)));
      text(c, tagText, tag.x0 + tagW / 2, py + 0.5, tagFont, color(pal.bg));

      // Seconds ahead, along the foot: a tick each second, a longer one every five.
      for (let s = 0; s <= VIEW_SECONDS; s++) {
        const tx = Math.round(nx + s * 1000 * pxMs()) + 0.5;
        const major = s % 5 === 0;
        c.drawRect(Skia.XYWHRect(tx - 0.5, axisY - (major ? 8 : 4), 1, major ? 8 : 4), paintOf(color(pal.faint)));
      }
      const axisFont = font(400, 11);
      for (let s = 0; s <= VIEW_SECONDS; s += 5) text(c, s ? `${s}s` : "Now", nx + s * 1000 * pxMs(), axisY + 14, axisFont, color(pal.muted));

      /* The ink, on a layer of its own, so what the price has passed can be rubbed out of it without touching the chart. */
      c.saveLayer();
      // Other players' ink, under the player's own: one line a drawing, faint, stronger where it is in play.
      const remote = (l: { t0: number; p0: number; rt: number; rp: number }, path: SkPath, col: Float32Array) => {
        c.save();
        c.translate(x(l.t0), y(l.p0));
        c.scale(l.rt * pxMs(), (-l.rp * pitchY) / g.step);
        c.drawPath(path, paintOf(col, 2));
        c.restore();
      };
      const people = remoteDrawings().slice(0, phone() ? 12 : 18);
      const viewFrom = tAt(0), viewTo = tAt(w);
      for (const drawing of people) {
        const age = Math.max(0, Date.now() - drawing.updatedAt);
        if (drawing.complete && age > 15_000) continue;
        const l = remoteLine(drawing);
        if (!l || l.t0 > viewTo || drawing.pieces.every((q) => q.openAt + 30_000 < viewFrom)) continue;
        const rgb = hueRgb(drawing.player, pal.dark ? 70 : 42);
        const fade = drawing.complete ? Math.max(0, 1 - age / 15_000) : 1;
        remote(l, l.path, color(rgb, 0.16 * fade));
        const bands: { x: number; y: number; w: number; h: number }[] = [];
        for (const piece of drawing.pieces) {
          const pad = Number(piece.unit) / 1e8;
          for (const section of piece.sections) {
            const from = x(piece.openAt + section.second * 1000), top = y(Number(section.hi) / 1e8 + pad);
            bands.push({ x: from, y: top, w: x(piece.openAt + (section.second + 1) * 1000) - from, h: y(Number(section.lo) / 1e8 - pad) - top });
          }
        }
        c.save();
        clipTo(c, bands);
        remote(l, l.path, color(rgb, 0.4 * fade));
        c.restore();
      }
      // Lines being drawn right now, elsewhere: faint, catching up smoothly between their ten updates a second.
      const pens = livePens();
      for (const p of pens) {
        if (p.shown < p.pts.length) p.shown = Math.min(p.pts.length, p.shown + Math.max(1, Math.ceil((p.pts.length - p.shown) / 5)));
        if (p.shown) remote(p, penLine(p), color(hueRgb(p.player, pal.dark ? 70 : 42), 0.32));
      }
      if (renderedBets !== g.bets) {
        renderedBets = g.bets;
        const groups = new Map<string, (typeof renderedGroups)[number]>();
        for (const bet of g.bets) {
          if (bet.status === "void") continue;
          const id = bet.group ?? bet.id;
          let group = groups.get(id);
          if (!group) groups.set(id, (group = { id, stroke: bet.stroke, cells: [], edgeCells: bet.edgeCells ?? 0, step: bet.step }));
          else if (bet.stroke.pts.length > group.stroke.pts.length) group.stroke = bet.stroke;
          for (const q of bet.status === "opening" ? bet.drawn : bet.cells) if (!(q as BetCell).expired) group.cells.push(q);
        }
        renderedGroups = [...groups.values()];
      }
      for (const group of renderedGroups) {
        if (group.id !== pen?.drawing) {
          ink(c, group.stroke, color(pal.ink, 0.3));
          inkInPlay(c, group.stroke, group.cells, solid, group.edgeCells, group.step);
        }
      }
      // What the chain did not take, fading from solid to what is left of it: the faint line (0.886 over it is the
      // solid 0.92 drawn over faint ink), or nothing. Only while it fades, and with Reduce Motion not at all.
      if (g.gone?.length) {
        if (still.current || g.gone.every((q) => ms - q.born >= GONE_MS)) g.gone = [];
        for (const q of g.gone) {
          const left = 1 - Math.min(1, (ms - q.born) / GONE_MS);
          if (left <= 0) continue;
          if (q.whole) ink(c, q.stroke, color(pal.ink, 0.3 * left));
          inkInPlay(c, q.stroke, q.cells, color(pal.ink, (q.whole ? 0.92 : 0.886) * left), q.edgeCells, q.step);
        }
      }
      if (pen) {
        const from = x(openFor(at) + 1000);
        c.save();
        c.clipRect(Skia.XYWHRect(from, 0, w - from, h), ClipOp.Intersect, true);
        ink(c, pen.stroke, solid);
        c.restore();
        c.save();
        c.clipRect(Skia.XYWHRect(0, 0, from, h), ClipOp.Intersect, true);
        ink(c, pen.stroke, color(pal.ink, 0.3));
        c.restore();
      }
      // Ink the price has passed is spent: it ends at the price line.
      c.drawRect(Skia.XYWHRect(0, 0, nx, h), eraser);
      // Ink the price missed turns red as the price passes it, and fades.
      for (const bet of g.bets) {
        const misses = bet.cells.filter((q) => q.status === "miss" && !q.expired && at - (q.t + 1000) < 2200);
        if (!misses.length) continue;
        const pad = (bet.edgeCells ?? 0) * bet.step * INK_CELL;
        const age = Math.max(0, Math.min(1, (at - (Math.max(...misses.map((q) => q.t)) + 1000)) / 2200));
        c.save();
        clipTo(c, misses.map((q) => ({ x: x(q.t), y: y(q.hi + pad), w: pxMs() * 1000, h: y(q.lo - pad) - y(q.hi + pad) })));
        ink(c, bet.stroke, color(pal.down, 0.5 * (1 - age * age)));
        c.restore();
      }
      // Where the price ran through the ink, it glows green for a moment: there, and nowhere else.
      for (const bet of g.bets) {
        const hits = bet.cells.filter((q) => q.status === "hit" && at - (q.t + 1000) < 2200);
        if (!hits.length) continue;
        const age = Math.max(0, Math.min(1, (at - (Math.max(...hits.map((q) => q.t)) + 1000)) / 2200));
        c.saveLayer(layerPaint(1 - age * age));
        ink(c, bet.stroke, green, 0.35);
        c.saveLayer(layerPaint(1, BlendMode.DstIn));
        for (const q of hits) {
          const lo = Math.max(q.lo, q.range?.[0] ?? q.lo);
          const hi = Math.min(q.hi, q.range?.[1] ?? q.hi);
          const cx = x(q.t + 500);
          const cy = (y(lo) + y(hi)) / 2;
          const rx = pxMs() * 600;
          const ry = Math.max(4, (y(lo) - y(hi)) / 2) + radius();
          const spot = Skia.Paint();
          spot.setShader(Skia.Shader.MakeRadialGradient({ x: 0, y: 0 }, ry, [Skia.Color("rgba(0,0,0,1)"), Skia.Color("rgba(0,0,0,0.9)"), Skia.Color("rgba(0,0,0,0)")], [0, 0.7, 1], TileMode.Clamp));
          c.save();
          c.translate(cx, cy);
          c.scale(rx / ry, 1);
          c.drawRect(Skia.XYWHRect(-ry, -ry, ry * 2, ry * 2), spot);
          c.restore();
        }
        c.restore();
        c.drawRect(Skia.XYWHRect(nx, 0, w - nx, h), eraser);
        c.restore();
      }
      c.restore();

      // The multiples, over the ink.
      if (tiles.length) {
        c.save();
        c.clipRect(Skia.XYWHRect(0, plotTop(), w, plotBottom() - plotTop()), ClipOp.Intersect, true);
        if (underPen) {
          const b = tileBox(underPen);
          const r = rrect(b.x0 - 1, b.y0 - 1, b.w + 2, b.h + 2, phone() ? 10 : 13);
          c.drawRRect(r, paintOf(color(pal.ink, 0.14)));
          c.drawRRect(r, paintOf(color(pal.ink), 1.5));
        }
        const size = phone() ? 11 : 14;
        for (const tile of tiles) {
          if (tile.opacity < 0.01) continue;
          const b = tileBox(tile);
          const k = still.current ? 1 : Math.min(1, (ms - tile.changed) / 260);
          const eased = k * k * (3 - 2 * k);
          const write = (s: string, alpha: number) => {
            if (alpha < 0.01 || !s) return;
            const m = parseFloat(s);
            text(c, s, b.x0 + b.w / 2, b.y0 + b.h / 2 + 0.5, font(m >= 8 ? 600 : 500, size), color(mix(pal.faint, pal.ink, height(m)), tile.opacity * alpha));
          };
          if (tile.was !== tile.text && eased < 1) {
            if (eased < 0.5) write(tile.was, 1 - eased * 2);
            else write(tile.text, eased * 2 - 1);
          } else write(tile.text, 1);
        }
        c.restore();
      }

      // A face and a figure on each drawing being played, and on each pen drawing now. Images made once each.
      {
        const chip = (player: string, seed: string, ax: number, ay: number, r: number, label: string, alpha: number, good: boolean) => {
          c.drawCircle(ax, ay, r, paintOf(color(hueRgb(player, pal.dark ? 55 : 45), alpha)));
          const image = faceImage(seed);
          if (image) {
            c.save();
            c.clipRRect(rrect(ax - r, ay - r, r * 2, r * 2, r), ClipOp.Intersect, true);
            c.drawImageRect(image, Skia.XYWHRect(0, 0, 64, 64), Skia.XYWHRect(ax - r, ay - r, r * 2, r * 2), paintOf(color(pal.fg, alpha)));
            c.restore();
          }
          const f = font(600, 12);
          const wide = measure(f, label) + 16;
          const left = Math.min(w - wide - 8, ax + r + 5);
          c.drawRRect(rrect(left, ay - 12, wide, 24, 12), paintOf(color(pal.bg, 0.94 * alpha)));
          text(c, label, left + 8, ay + 0.5, f, good ? color(pal.up, alpha) : color(pal.fg, 0.8 * alpha), "left");
        };
        const occupied: { x: number; y: number }[] = [];
        const limit = phone() ? 4 : 6;
        for (const drawing of visibleSocialDrawings().slice(0, phone() ? 12 : 18)) {
          if (occupied.length >= limit) break;
          const piece = drawing.pieces.find((q) => q.stroke?.pts.length);
          if (!piece?.stroke) continue;
          const age = Math.max(0, Date.now() - drawing.updatedAt);
          if (drawing.complete && age > 15_000) continue;
          const start = piece.stroke.pts[0];
          const ax = x(piece.stroke.t0 + start.t), ay = y(piece.stroke.p0 + start.p) - 24;
          if (ax < 24 || ax > w - 24 || ay < plotTop() + 24 || ay > plotBottom() - 20 || occupied.some((o) => Math.abs(o.x - ax) < 100 && Math.abs(o.y - ay) < 42)) continue;
          occupied.push({ x: ax, y: ay });
          let figure = figures.get(drawing);
          if (!figure) figures.set(drawing, (figure = drawing.complete ? socialMoney(drawing.pnl, true) : socialMoney(drawing.stake)));
          chip(drawing.player, avatarSeedOf(drawing.profile), ax, ay, 14, figure, drawing.complete ? Math.max(0, 1 - age / 15_000) : 0.9, drawing.complete && BigInt(drawing.pnl) > 0n);
        }
        for (const p of pens) {
          if (!p.shown || p.ended) continue;
          const nib = p.pts[p.shown - 1];
          const ax = x(p.t0 + nib.t) + 18, ay = y(p.p0 + nib.p) - 18;
          if (ax < 16 || ax > w - 16 || ay < plotTop() + 12 || ay > plotBottom() - 12) continue;
          chip(p.player, p.profile ? avatarSeedOf(p.profile) : p.player, ax, ay, 11, "drawing…", 0.85, false);
        }
      }
      // The pen: a soft ring around the nib, and the nib.
      if (tip) {
        c.drawCircle(tip.x, tip.y, Math.max(18, radius() + 8), paintOf(color(pal.ink, 0.16)));
        c.drawCircle(tip.x, tip.y, 6.5, paintOf(color(pal.bg)));
        c.drawCircle(tip.x, tip.y, 6.5, paintOf(color(pal.ink), 3));
      }

      // Hits burst and float what they paid; a drawing pops once when it goes in.
      g.fx = g.fx.filter((e) => ms - e.born < 1500);
      for (const e of g.fx) {
        const age = (ms - e.born) / 1500;
        const ex = x(e.t);
        const ey = y(e.price);
        if (e.kind === "hit") {
          const grow = still.current ? 1 : 0.6 + age * 0.8;
          c.drawCircle(ex, ey, (e.big ? 34 : 26) * grow, paintOf(color(pal.up, 0.5 * (1 - age)), 2));
          c.drawCircle(ex, ey, (e.big ? 52 : 40) * grow, paintOf(color(pal.up, 0.25 * (1 - age)), 1.2));
          // The spray is a celebration, so only a hit in a round that is ahead has one.
          const n = still.current || e.profit === false ? 0 : e.big ? 22 : 14;
          for (let i = 0; i < n; i++) {
            const a = (i / n) * Math.PI * 2 + e.born;
            const d = (e.big ? 44 : 30) * (0.55 + (0.45 * ((i * 7919) % 11)) / 11) * Math.min(1, age * 2.2);
            c.drawCircle(ex + Math.cos(a) * d, ey + Math.sin(a) * d, (1.8 + (i % 3) * 0.6) * (1 - age * 0.6), paintOf(color(pal.up, 1 - age)));
          }
          if (e.text) {
            const alpha = Math.max(0, Math.min(1, 1.6 - age * 1.6));
            const f = font(700, e.big ? 17 : 15);
            const tw = measure(f, e.text) + 24;
            const cx = Math.min(w - tw / 2 - 8, Math.max(tw / 2 + 8, ex));
            const cy = ey - 62 - (still.current ? 0 : age * 24);
            c.drawRRect(rrect(cx - tw / 2, cy - 14, tw, 28, 14), paintOf(e.loss ? color(pal.down, alpha) : color(pal.up, alpha)));
            text(c, e.text, cx, cy + 0.5, f, color([255, 255, 255], alpha));
          }
        } else if (e.kind === "miss") {
          // A miss: a red ring shrinking away where the price passed, and what it cost floating up, smaller than a hit's.
          c.drawCircle(ex, ey, (still.current ? 14 : 22 - age * 10) , paintOf(color(pal.down, 0.45 * (1 - age)), 1.5));
          if (e.text) {
            const alpha = Math.max(0, Math.min(1, 1.5 - age * 1.5));
            const f = font(600, 13);
            const tw = measure(f, e.text) + 18;
            const cx = Math.min(w - tw / 2 - 8, Math.max(tw / 2 + 8, ex));
            const cy = ey - 40 - (still.current ? 0 : age * 18);
            c.drawRRect(rrect(cx - tw / 2, cy - 12, tw, 24, 12), paintOf(color(pal.down, 0.9 * alpha)));
            text(c, e.text, cx, cy + 0.5, f, color([255, 255, 255], alpha));
          }
        } else if (e.kind === "burst") {
          // Handed to the confetti's own canvas the first frame it is seen; here only a flash of light where it came from.
          if (!e.thrown) {
            e.thrown = true;
            if (!still.current) g.burst?.(ex, ey, e.tier ?? 1);
          }
          const life = (ms - e.born) / 700;
          if (life < 1) {
            const out = still.current ? 1 : 1 - (1 - life) ** 3;
            const r = (28 + 18 * (e.tier ?? 1)) * (0.4 + 0.6 * out);
            c.drawCircle(ex, ey, r, paintOf(color(pal.up, 0.16 * (1 - life))));
            c.drawCircle(ex, ey, r * 0.55, paintOf(color(pal.up, 0.22 * (1 - life))));
          }
        } else if (e.kind === "drop") {
          const life = Math.min(1, (ms - e.born) / 520);
          if (life >= 1) continue;
          const out = still.current ? 1 : 1 - (1 - life) ** 3;
          c.drawCircle(ex, ey, 6 + 10 * out, paintOf(color(pal.ink, 0.28 * (1 - life))));
          c.drawCircle(ex, ey, 10 + 30 * out, paintOf(color(pal.ink, 0.55 * (1 - life)), 2 * (1 - life) + 0.5));
        } else {
          c.drawCircle(ex, ey, 8 + (still.current ? 0 : 20 * (1 - (1 - age) ** 3)), paintOf(color(pal.fg, 0.4 * (1 - age)), 1.5));
        }
      }

      // Why a drawing did not go in, where the pen was.
      if (flash) {
        const age = (ms - flash.born) / (flash.ms ?? 1700);
        if (age >= 1) flash = null;
        else {
          const f = font(600, 12);
          const tw = measure(f, flash.text) + 22;
          const fx = Math.min(w - tw / 2 - 8, Math.max(tw / 2 + 8, flash.x));
          c.drawRRect(rrect(fx - tw / 2, flash.y - 46, tw, 28, 14), paintOf(color(pal.fg, 0.95 * (1 - age * age))));
          text(c, flash.text, fx, flash.y - 31.5, f, color(pal.bg, 1 - age * age));
        }
      }
    };
    if (active) raf = requestAnimationFrame(frame);
    return () => {
      appState.remove();
      cancel();
      clearInterval(stream);
      if (streaming) penLift(streaming);
      cancelAnimationFrame(raf);
      handlers.current = null;
    };
  }, [game, picture]);

  // Made once: a new gesture each render had the gesture handler reconfigure natively, up to 40 times a second.
  const pan = useMemo(
    () =>
      Gesture.Pan()
        .minDistance(0)
        .shouldCancelWhenOutside(false)
        .runOnJS(true)
        .onBegin((e) => handlers.current?.down(e.x, e.y))
        .onUpdate((e) => handlers.current?.move(e.x, e.y))
        .onEnd((e) => handlers.current?.up(e.x, e.y))
        // A tap never moves far enough to activate the pan: it ends as failed, and is the finger lifting all the same.
        // Only the system taking the touch back (a notification pulled down, say) is a cancel.
        .onFinalize((e) => {
          if (e.state === State.CANCELLED) handlers.current?.cancel();
          else handlers.current?.up(e.x, e.y);
        }),
    [],
  );

  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height: h } = e.nativeEvent.layout;
    size.current = { w: width, h };
    viewport.current({ width, height: h });
  };

  return (
    <GestureDetector gesture={pan}>
      <View style={{ flex: 1 }} onLayout={onLayout} accessibilityLabel="Draw ahead of the price" accessible>
        <Canvas style={{ flex: 1 }}>
          <Picture picture={picture} />
        </Canvas>
      </View>
    </GestureDetector>
  );
});
