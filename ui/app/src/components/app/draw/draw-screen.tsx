"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSettings } from "@/lib/settings";
import { type Candle, candlesFor, type Market, signedUsd } from "@/lib/market";
import { accuracyOf, type Exits, extend, nextCandle, type Outcome, type Pt, quote as quoteFor, ribbonFor, SAMPLES, settle, shapeOf, simplify } from "@/lib/sketch";
import { MarketHeader } from "../market-header";
import { PlaceTicket } from "./place-ticket";
import { DrawTools, type Preset, PRESETS } from "./draw-tools";
import { type Band, type Phase, SketchCanvas } from "./sketch-canvas";
import { SketchBar } from "./sketch-tray";
import { RoundsSheet, seedSketches, type Sketch } from "./sketches";

/**
 * Draw: the chart, the line you put on it, what the line is worth. The feed is simulated, one
 * candle a second, pulled toward the line by a factor rolled once per sketch.
 */

const HISTORY = 90;
/** A candle is a second and a round starts at a minute of them. Drawing off the right edge lengthens it. */
const RUN_BARS = 60;
/** The shortest a round can be, in candles. Five seconds is a coin toss, not a call. */
const MIN_BARS = 5;

/** How long a round this line makes: its last second, never shorter than MIN_BARS. */
const barsFor = (pts: Pt[], horizon: number) => Math.max(MIN_BARS, Math.round((pts[pts.length - 1]?.t ?? 1) * horizon));
/** As long as a sketch may get. Five minutes is already a long wait. */
const RUN_MAX = 300;
/** A bar a second, in real time, with the forming one moving twice a second. */
const TICK_MS = 1000;
const SUB_MS = 500;
/**
 * Per-second move as a share of price. Bitcoin near 50% annualised is about 0.01% a second, six
 * dollars on $64k. The old 0.0016 was a market having the worst day of its life, forever.
 */
const VOL = 0.0002;

function bandFor(candles: Candle[], center: number, extra: number[] = []): Band {
  /* A floor on the vertical scale so a quiet market still has visible bodies: 0.06% either side. */
  let reach = center * 0.0006;
  for (const c of candles) reach = Math.max(reach, Math.abs(c.h - center), Math.abs(c.l - center));
  for (const p of extra) reach = Math.max(reach, Math.abs(p - center));
  const pad = reach * 1.2;
  return { lo: center - pad, hi: center + pad };
}

function easeBand(from: Band, to: Band): Band {
  const k = 0.12;
  return { lo: from.lo + (to.lo - from.lo) * k, hi: from.hi + (to.hi - from.hi) * k };
}

export function DrawScreen({ market }: { market: Market }) {
  // Draw's own. The desk ticket's pay and leverage are a different field.
  /* What you put in last. A round that resets to the default every time makes
     you set the same two figures before every line you draw. */
  const [{ stake, leverage }, setSettings] = useSettings();
  const setStake = (next: number) => setSettings({ stake: next });
  const setLeverage = (next: number) => setSettings({ leverage: next });
  /** Where to get out, in dollars. Both optional; empty means neither. */
  const [exits, setExits] = useState<Exits>({ lose: null, gain: null });
  /* History from the same process as the live feed, so its bars are the same height as the live ones. */
  const seed = useMemo(() => candlesFor(market, "1m", HISTORY, VOL), [market]);

  const [phase, setPhase] = useState<Phase>("live");
  /**
   * How long this sketch is, in candles. State because the line decides it: draw past the edge and
   * the round grows.
   */
  const [runBars, setRunBars] = useState(RUN_BARS);
  /** The same number, readable between renders by the growth loop. */
  const barsRef = useRef(RUN_BARS);
  /**
   * How much future the chart shows, frozen when the round starts, so a growing round scrolls in
   * instead of squeezing the window.
   */
  const [viewBars, setViewBars] = useState(RUN_BARS);
  const [pts, setPts] = useState<Pt[]>([]);
  const [feed, setFeed] = useState<Candle[]>(seed);
  const [run, setRun] = useState<Candle[]>([]);
  const [entry, setEntry] = useState(market.price);
  const [band, setBand] = useState<Band>(() => bandFor(seed, market.price));
  const [sketches, setSketches] = useState<Sketch[]>(() => seedSketches(market));
  const [listOpen, setListOpen] = useState(false);
  const [lastSketch, setLastSketch] = useState<Sketch | null>(null);
  /** The point under the finger, while one is. */
  const dragIndex = useRef<number | null>(null);
  /** Where the finger landed, for a tap that becomes a point. */
  const tapAt = useRef<Pt | null>(null);

  const follow = useRef(0);
  const lastT = useRef(-1);
  const kept = useRef(0);
  const anchor = useRef(0);

  const price = run.at(-1)?.c ?? feed.at(-1)?.c ?? market.price;
  const prev = market.price - market.change;
  /**
   * Until you press the button the line rides the live price: `pts` keeps the shape, `view` is the
   * shape moved to today.
   */
  const riding = phase === "drawn" && pts.length > 0;
  const entryView = riding ? price : entry;
  const view = useMemo(() => {
    if (!riding) return pts;
    const shift = price - pts[0].price;
    return pts.map((p) => ({ ...p, price: p.price + shift }));
  }, [riding, pts, price]);
  const shape = useMemo(() => shapeOf(view, entryView), [view, entryView]);
  const quote = useMemo(() => (shape ? quoteFor(shape, entryView, stake, leverage, exits) : null), [shape, entryView, stake, leverage, exits]);
  const book = useMemo(
    () => (shape && run.length > 0 ? settle(run, shape, entry, stake, leverage, runBars, exits) : null),
    [run, shape, entry, stake, leverage, runBars, exits],
  );
  const ribbon = useMemo(() => ribbonFor(feed), [feed]);
  /** Your last line, moved to today's price. */
  const ghost = useMemo(
    () => (lastSketch && phase === "live" ? lastSketch.pts.map((p) => ({ t: p.t, price: p.price + (price - lastSketch.entry) })) : null),
    [lastSketch, phase, price],
  );

  const live = useRef({ phase, shape, run, feed, entry, stake, leverage, ribbon, runBars, exits });
  useEffect(() => {
    live.current = { phase, shape, run, feed, entry, stake, leverage, ribbon, runBars, exits };
  });

  const finish = useCallback((bars: Candle[], early: boolean) => {
    const { shape: sh, entry: en, stake: st, leverage: lev, runBars: rbars, exits: ex } = live.current;
    if (!sh) return;
    const bk = settle(bars, sh, en, st, lev, rbars, ex);
    const acc = accuracyOf(bars, sh.prices, rbars);
    const outcome: Outcome | "closed" = early && bk.done === null ? "closed" : (bk.done ?? "time");
    // The round is kept whole on its record: what arrived, how long it was, how it ended. That is what replays and exports.
    const settled = (s: Sketch): Sketch => ({ ...s, status: "settled", net: bk.net, exit: bk.exit, right: acc.right, outcome, run: bars, runBars: rbars });
    setSketches((list) => list.map((s) => (s.status === "running" ? settled(s) : s)));
    setLastSketch((s) => (s ? settled(s) : s));
    // The round stays on screen: dashed line, coloured ribbon, the gap. It
    // folds into history when the next line starts. And the rounds sheet
    // opens on it, where every earlier round already is.
    setPhase("settled");
    setListOpen(true);
  }, []);

  /** Put a finished round behind us before the next one. */
  const fold = () => {
    if (run.length) setFeed((f) => [...f, ...run].slice(-HISTORY));
    setRun([]);
    setPts([]);
    setRunBars(RUN_BARS);
    barsRef.current = RUN_BARS;
    setViewBars(RUN_BARS);
  };

  useEffect(() => {
    /* The feed is not decoration, so reduced motion does not stop it. It used
       to return here, which meant the market never moved and a round placed
       with that preference on never ran at all. What is decorative, the
       marching hint and the settled ribbon fading in, is CSS and stops. */
    const tick = setInterval(() => {
      const { phase: ph, shape: sh, run: rn, feed: fd, entry: en } = live.current;
      const now = Date.now();
      if (ph === "settled") return;
      if (ph !== "running" || !sh) {
        const next = [...fd.slice(1), nextCandle(fd.at(-1)?.c ?? en, VOL, now)];
        const last = next.at(-1)?.c ?? en;
        setFeed(next);
        setBand((b) => easeBand(b, bandFor(next, last, sh ? sh.prices : [])));
        return;
      }
      const open = rn.at(-1)?.c ?? en;
      const along = sh.prices[Math.min(SAMPLES - 1, Math.round(((rn.length + 1) / live.current.runBars) * (SAMPLES - 1)))];
      const bar = nextCandle(open, VOL, now, along, follow.current);
      const next = [...rn, bar];
      setRun(next);
      setBand((b) => easeBand(b, bandFor([...fd, ...next].slice(-HISTORY), bar.c, sh.prices)));
      const bk = settle(next, sh, en, live.current.stake, live.current.leverage, live.current.runBars, live.current.exits);
      if (bk.done !== null || next.length >= live.current.runBars) finish(next, false);
    }, TICK_MS);
    const sub = setInterval(() => {
      const { phase: ph, run: rn } = live.current;
      if (ph === "settled") return;
      if (ph === "running" && rn.length) setRun((r) => (r.length ? [...r.slice(0, -1), extend(r[r.length - 1], VOL)] : r));
      else setFeed((f) => (f.length ? [...f.slice(0, -1), extend(f[f.length - 1], VOL)] : f));
    }, SUB_MS);
    return () => {
      clearInterval(tick);
      clearInterval(sub);
    };
  }, [finish]);

  /** Points at or before this time have already happened. */
  const editableFrom = phase === "running" ? run.length / runBars + 0.01 : 0;


  /**
   * Make the round long enough to hold a point at this time, rescaling every t. Growing by exactly
   * the factor asked lands the head on the edge. Returns the point's new t.
   */
  const coverTo = useCallback((t: number) => {
    const bars = barsRef.current;
    if (t <= 1) return t;
    if (bars >= RUN_MAX) return 1;
    const next = Math.min(RUN_MAX, bars * t);
    const k = bars / next;
    barsRef.current = next;
    setRunBars(next);
    setPts((p) => p.map((pt) => ({ ...pt, t: pt.t * k })));
    // And the pen's own memory of where it got to.
    lastT.current *= k;
    return Math.min(1, t * k);
  }, []);

  /** Open the price scale to the hand in the same frame, rather than a tick later through `bandFor`. */
  const stretchTo = (price: number) => {
    setBand((b) => {
      const pad = (b.hi - b.lo) * 0.12;
      if (price > b.hi - pad) return { lo: b.lo, hi: price + pad };
      if (price < b.lo + pad) return { lo: price - pad, hi: b.hi };
      return b;
    });
  };

  /** Start a line at the live price. A finger lands wherever it lands; the
      gap is carried through the whole drawing. */
  const begin = (pt: Pt) => {
    fold();
    kept.current = 0;
    lastT.current = -1;
    anchor.current = price - pt.price;
    setEntry(price);
    setPts([{ t: 0, price }]);
  };
  /** In today's prices, as the canvas hands them over. */
  const clampT = (t: number, index: number, list: Pt[]) => {
    const lo = (list[index - 1]?.t ?? 0) + 0.02;
    const hi = (list[index + 1]?.t ?? 1.0) - (index + 1 < list.length ? 0.02 : 0);
    return Math.min(Math.max(t, lo), Math.min(1, hi));
  };

  /** A point taken hold of. */
  const onGrab = (index: number) => {
    dragIndex.current = index;
  };

  /** A point removed. Two points is the least that is still a line. */
  const onRemove = (index: number) => {
    setPts((p) => {
      if (p.length <= 2) return p;
      return p.filter((_, i) => i !== index);
    });
  };

  const onDown = (pt: Pt) => {
    if ((phase === "drawn" || phase === "running") && pts.length > 1) {
      // Another point, where you clicked, in time order. Ahead of now only.
      if (pt.t <= editableFrom) return;
      // While the line rides the price the stored shape is offset from today.
      const offset = phase === "drawn" ? pts[0].price - price : 0;
      const t = coverTo(pt.t);
      setPts((p) => {
        // A click on the minute a point already sits in takes hold of that
        // point. Adding a second one there would draw a vertical leg, which
        // is a move in no time and trades as nothing.
        const near = p.findIndex((q) => Math.abs(q.t - t) < 0.015);
        if (near > 0) {
          dragIndex.current = near;
          return p.map((q, j) => (j === near ? { t: q.t, price: pt.price + offset } : q));
        }
        const i = p.findIndex((q) => q.t > t);
        const index = i === -1 ? p.length : i;
        dragIndex.current = index;
        return [...p.slice(0, index), { t, price: pt.price + offset }, ...p.slice(index)];
      });
      return;
    }
    if (phase === "running") return;
    // Nothing drawn yet: this is a stroke, and the line follows the finger.
    // If the finger lifts without moving, it was a click, and a click is a
    // point: the line starts at now and ends where you clicked.
    tapAt.current = pt;
    begin(pt);
    setPhase("drawing");
  };

  const onMove = (pt: Pt) => {
    const i = dragIndex.current;
    if (i !== null) {
      // Moving a point: both axes, held between its neighbours in time. While
      // the line rides the price the stored shape is offset from today.
      const offset = phase === "drawn" ? pts[0].price - price : 0;
      // Only the head can lengthen the round. A point in the middle is penned
      // in by its neighbours however far right you drag it, so asking for more
      // minutes on its behalf would buy time nothing can use.
      const want = i === pts.length - 1 ? coverTo(pt.t) : pt.t;
      stretchTo(pt.price + offset);
      setPts((p) => {
        if (!p[i]) return p;
        const t = i === p.length - 1 && phase === "drawing" ? Math.max(want, 0.03) : clampT(want, i, p);
        return p.map((q, j) => (j === i ? { t, price: pt.price + offset } : q));
      });
      return;
    }
    if (phase !== "drawing") return;
    // The stroke itself. A point every hundredth or so of the round, which is
    // finer than a bar and far finer than anything that can be traded, the
    // shape is what is being captured, not the samples.
    if (pt.t - lastT.current < 0.008) return;
    const t = coverTo(pt.t);
    lastT.current = t;
    kept.current += 1;
    // The line lags the finger a little, so a shaky hand draws a calm one.
    // Only a little: at much less than this every peak is rounded off before
    // the line is even simplified, and a sharp turn is usually the point.
    const target = { t, price: pt.price + anchor.current };
    stretchTo(target.price);
    setPts((p) => {
      const last = p[p.length - 1];
      const eased = last ? last.price + (target.price - last.price) * 0.85 : target.price;
      return [...p, { t: target.t, price: eased }];
    });
  };

  const onUp = () => {
    const drew = dragIndex.current === null && phase === "drawing";
    dragIndex.current = null;
    if (drew) {
      // A tap is a point. The line runs from now to where you clicked, and
      // the next click adds the next point. A stroke settles into the turns
      // that shape it, so it edits as handles from here on either way.
      if (kept.current < 3) {
        const at = tapAt.current;
        if (!at) {
          setPts([]);
          setPhase("live");
          return;
        }
        // Where you clicked, not where the stroke's anchor would have put
        // it: the anchor pins a stroke's first touch to the live price, and
        // applying it to a tap flattened every first point onto the entry.
        const t = coverTo(Math.max(at.t, 0.03));
        setPts([{ t: 0, price }, { t, price: at.price }]);
        setPhase("drawn");
        return;
      }
      setPts((p) => simplify(p, band.hi - band.lo, entry));
    }
    if (phase !== "drawing") return;
    setPhase("drawn");
  };

  const onUndo = () => {
    setPts((p) => {
      const next = p.slice(0, -1);
      if (next.length < 2) {
        setPhase("live");
        return [];
      }
      return next;
    });
  };

  const onClear = () => {
    fold();
    setPhase("live");
  };

  /** A common call, drawn for you at the scale of the chart. Drag it after. */
  const onPreset = (preset: Preset) => {
    const amp = (band.hi - band.lo) * 0.16;
    const ms = PRESETS.find((p) => p.value === preset)?.shape ?? [0, 1];
    fold();
    setEntry(price);
    setPts(ms.map((m, i) => ({ t: i / (ms.length - 1), price: price + m * amp })));
    kept.current = ms.length;
    setPhase("drawn");
  };

  const onPlace = () => {
    if (!shape) return;
    // The round is as long as the line. A line that stops at ten minutes is
    // a ten minute call, so the clock stops where the drawing does, and the
    // points are rescaled so the line spans the whole round.
    const end = view[view.length - 1]?.t ?? 1;
    const horizon = barsRef.current;
    const bars = barsFor(view, horizon);
    const moved = end > 0 ? view.map((p) => ({ ...p, t: Math.min(1, p.t / end) })) : view;
    setPts(moved);
    setRunBars(bars);
    barsRef.current = bars;
    setEntry(price);
    follow.current = -0.12 + Math.random() * 0.62;
    const sketch: Sketch = { id: `sk-${Date.now()}`, long: shape.long, stake, leverage, entry: price, pts: moved, placedAt: Date.now(), status: "running", net: 0 };
    setLastSketch(sketch);
    setSketches((list) => [sketch, ...list]);
    setRun([]);
    // The window stays where it was while you drew. A short round ends part
    // way across it; zooming in to fit would yank the picture the moment you
    // press the button.
    setViewBars(horizon);
    setPhase("running");
    // No toast. The header turns into "Close trade", the bar starts counting
    // candles and the chart starts moving: three things already say it.
  };

  // Escape clears, Z or Backspace undoes. Only while the line is yours.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (phase !== "drawn" && phase !== "drawing") return;
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;
      if (document.querySelector('[role="dialog"], [role="menu"], [data-slot="popover-popup"]')) return;
      if (e.key === "Escape") onClear();
      else if (e.key === "Backspace" || e.key === "Delete" || (e.key.toLowerCase() === "z" && (e.metaKey || e.ctrlKey))) {
        e.preventDefault();
        onUndo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  /* Signed, because net of fees this goes negative: at fifty times a hundred
     dollars they are $4.50, and a line that only reaches for four dollars is a
     trade that costs money to be right about. It read "+$-4" before. */
  const headLabel = shape && quote ? `${signedUsd(quote.ifWorks, 0)} if it gets here` : null;

  const shown = useMemo(
    () => (phase === "running" && book ? sketches.map((s) => (s.status === "running" ? { ...s, net: book.net } : s)) : sketches),
    [sketches, book, phase],
  );

  return (
    <section aria-label="Draw" className="m-2 flex min-h-[24rem] flex-1 flex-col overflow-hidden rounded-2xl border bg-background">
      {/* Market on the left; exits, size, boost and the button hard right, on the chart's own header. */}
      <div className="flex flex-wrap items-center gap-1.5 border-b px-2 py-2 sm:gap-2 sm:px-3">
        <MarketHeader className="w-full sm:w-auto" market={{ ...market, price, change: price - prev, changePct: ((price - prev) / prev) * 100 }} />
        {/* On a phone the rail sits in the header row, under the market line. */}
        {phase === "live" || phase === "drawing" || phase === "drawn" ? (
          <div className="sm:hidden"><DrawTools canUndo={pts.length > 1} onClear={onClear} onPreset={onPreset} onUndo={onUndo} /></div>
        ) : null}
        <PlaceTicket
          className="ml-auto"
          exits={exits}
          leverage={leverage}
          market={market}
          onCloseNow={() => run.length && finish(run, true)}
          onDrawAgain={() => {
            fold();
            setPhase("live");
          }}
          onExits={setExits}
          onLeverage={setLeverage}
          onPlace={onPlace}
          onStake={setStake}
          phase={phase}
          quote={quote}
          shape={shape}
          stake={stake}
        />
      </div>
      <div className="flex min-h-0 flex-1 gap-2 px-2 pt-2">
        {phase === "live" || phase === "drawing" || phase === "drawn" ? (
          <div className="hidden sm:block"><DrawTools canUndo={pts.length > 1} onClear={onClear} onPreset={onPreset} onUndo={onUndo} /></div>
        ) : null}
        <div className="min-w-0 flex-1">
        <SketchCanvas
          band={band}
          feed={feed}
          headLabel={headLabel}
          /*
            A fixed window while drawing: the round grows as you draw, and fitting it shrank the
            bars under the hand. Only `drawn` fits the whole plan.
          */
          horizonSeconds={phase === "drawn" ? runBars : viewBars}
          editableFrom={editableFrom}
          onDown={onDown}
          onGrab={onGrab}
          onMove={onMove}
          onRemove={onRemove}
          onUp={onUp}
          phase={phase}
          pnl={book?.net ?? null}
          price={price}
          pts={view}
          run={run}
          runBars={runBars}
          shape={shape}
          ghost={ghost}
          ribbon={ribbon}
        />
        </div>
      </div>
      {/* The bar takes its row; the plot above it is never covered. */}
      <div className="border-t px-3 py-3">
        <SketchBar
          market={market}
          onOpenList={() => setListOpen(true)}
          openCount={sketches.length}
          phase={phase}
          quote={quote}
          runCount={run.length}
          runBars={phase === "drawn" ? barsFor(view, runBars) : runBars}
          shape={shape}
          sketches={shown}
        />
      </div>
      <RoundsSheet
        market={market}
        onNext={() => {
          setListOpen(false);
          fold();
          setPhase("live");
        }}
        onOpenChange={setListOpen}
        open={listOpen}
        sketches={shown}
      />
    </section>
  );
}
