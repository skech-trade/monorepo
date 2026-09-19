"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toastManager } from "@/components/ui/toast";
import { type Candle, candlesFor, price as fmtPrice, type Market, signedUsd, usd } from "@/lib/market";
import { accuracyOf, extend, nextCandle, type Outcome, type Pt, quote as quoteFor, ribbonFor, SAMPLES, settle, shapeOf, verdictWord } from "@/lib/sketch";
import { MarketHeader } from "../market-header";
import { DrawTools, type Preset, PRESETS } from "./draw-tools";
import { type Band, type Phase, SketchCanvas } from "./sketch-canvas";
import { type Result, SketchBar } from "./sketch-tray";
import { seedSketches, type Sketch, SketchesSheet } from "./sketches";

/**
 * Draw. The chart, the line you put on it, what the line is worth.
 * The feed is simulated, one candle a second, pulled toward the line by a
 * factor rolled once per sketch. Swap the feed and the rest stays.
 */

const HISTORY = 46;
/**
 * Candles a sketch starts with. On one-minute bars that is the horizon in
 * minutes — and it is a starting length, not a limit: drawing off the right
 * edge lengthens the round.
 */
const RUN_BARS = 24;
/**
 * How fast the round lengthens while the pen is held at the edge, per second.
 *
 * A tenth, and it compounds, so the longer you hold the more room arrives — but
 * gently: a second of holding turns twenty-four candles into twenty-six.
 *
 * It grew in chunks before, on every pointer move. Two things were wrong with
 * that. Holding the pen still produced no moves at all, so the canvas stopped
 * opening exactly when you were asking it to; and each chunk was half the round
 * arriving at once, which threw the whole picture sideways under your hand.
 */
const RUN_GROWTH = 1.1;
/** As long as a sketch may get. An hour and a half is already a long wait. */
const RUN_MAX = 96;
const TICK_MS = 1000;
const SUB_MS = 80;
const VOL = 0.0016;

function bandFor(candles: Candle[], center: number, extra: number[] = []): Band {
  let reach = center * 0.012;
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
  const [stake, setStake] = useState(100);
  const [leverage, setLeverage] = useState(10);
  const seed = useMemo(() => candlesFor(market, "1m").slice(-HISTORY), [market]);

  const [phase, setPhase] = useState<Phase>("live");
  /**
   * How long this sketch is, in candles.
   *
   * State rather than a constant because the line decides it. Draw to the right
   * edge and keep going and the round gets longer — which is the only honest
   * way to offer "let me draw further", since the edge was never the screen
   * running out, it was the round ending there.
   */
  const [runBars, setRunBars] = useState(RUN_BARS);
  /** The same number, readable between renders by the growth loop. */
  const barsRef = useRef(RUN_BARS);
  const [pts, setPts] = useState<Pt[]>([]);
  const [feed, setFeed] = useState<Candle[]>(seed);
  const [run, setRun] = useState<Candle[]>([]);
  const [entry, setEntry] = useState(market.price);
  const [band, setBand] = useState<Band>(() => bandFor(seed, market.price));
  const [result, setResult] = useState<Result | null>(null);
  const [sketches, setSketches] = useState<Sketch[]>(() => seedSketches(market));
  const [listOpen, setListOpen] = useState(false);
  const [lastSketch, setLastSketch] = useState<Sketch | null>(null);
  /** The point under the finger, while one is. */
  const dragIndex = useRef<number | null>(null);

  const follow = useRef(0);
  const lastT = useRef(-1);
  const kept = useRef(0);
  const anchor = useRef(0);

  const price = run.at(-1)?.c ?? feed.at(-1)?.c ?? market.price;
  const prev = market.price - market.change;
  /**
   * A line that is drawn but not placed starts where you get in, which is
   * now. So until you press the button the whole line rides the live price;
   * `pts` keeps the shape, `view` is the shape moved to today.
   */
  const riding = phase === "drawn" && pts.length > 0;
  const entryView = riding ? price : entry;
  const view = useMemo(() => {
    if (!riding) return pts;
    const shift = price - pts[0].price;
    return pts.map((p) => ({ ...p, price: p.price + shift }));
  }, [riding, pts, price]);
  const shape = useMemo(() => shapeOf(view, entryView), [view, entryView]);
  const quote = useMemo(() => (shape ? quoteFor(shape, entryView, stake, leverage) : null), [shape, entryView, stake, leverage]);
  const book = useMemo(() => (shape && run.length > 0 ? settle(run, shape, entry, stake, leverage) : null), [run, shape, entry, stake, leverage]);
  const ribbon = useMemo(() => ribbonFor(feed), [feed]);
  const accuracy = useMemo(() => (shape && run.length > 0 ? accuracyOf(run, shape.prices, ribbon, runBars) : null), [run, runBars, shape, ribbon]);
  /** Your last line, moved to today's price. */
  const ghost = useMemo(
    () => (lastSketch && phase === "live" ? lastSketch.pts.map((p) => ({ t: p.t, price: p.price + (price - lastSketch.entry) })) : null),
    [lastSketch, phase, price],
  );

  const live = useRef({ phase, shape, run, feed, entry, stake, leverage, ribbon, runBars });
  useEffect(() => {
    live.current = { phase, shape, run, feed, entry, stake, leverage, ribbon, runBars };
  });

  const finish = useCallback((bars: Candle[], early: boolean) => {
    const { shape: sh, entry: en, stake: st, leverage: lev, ribbon: rb, runBars: rbars } = live.current;
    if (!sh) return;
    const bk = settle(bars, sh, en, st, lev);
    const acc = accuracyOf(bars, sh.prices, rb, rbars);
    const done: Outcome = bk.done ?? "time";
    const res: Result = {
      net: bk.net,
      outcome: early && bk.done === null ? "closed" : done,
      entry: en,
      exit: bk.exit,
      long: sh.long,
      inside: acc.inside,
      flags: acc.flags,
      bias: acc.bias,
    };
    setResult(res);
    const word = verdictWord(done, acc.inside, bk.net);
    toastManager.add({ title: word, description: `${Math.round(acc.inside * 100)}% inside your ribbon. ${signedUsd(bk.net)} on $${usd(st, 0)}.`, type: bk.net >= 0 ? "success" : "error" });
    const settled = (s: Sketch): Sketch => ({ ...s, status: "settled", net: bk.net, exit: bk.exit, liquidated: done === "liquidated", accuracy: acc.inside });
    setSketches((list) => list.map((s) => (s.status === "running" ? settled(s) : s)));
    setLastSketch((s) => (s ? settled(s) : s));
    // The round stays on screen: dashed line, coloured ribbon, the gap. It
    // folds into history when the next line starts.
    setPhase("settled");
  }, []);

  /** Put a finished round behind us before the next one. */
  const fold = () => {
    if (run.length) setFeed((f) => [...f, ...run].slice(-HISTORY));
    setRun([]);
    setPts([]);
    setRunBars(RUN_BARS);
    barsRef.current = RUN_BARS;
    setResult(null);
  };

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
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
      const bk = settle(next, sh, en, live.current.stake, live.current.leverage);
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
   * The line runs off the end, so the end moves.
   *
   * Everything on this chart is positioned as a fraction of the round, so
   * lengthening it is one division: the points keep the minute they were drawn
   * at and simply sit a smaller fraction of the way along. The drawing slides
   * left and fresh canvas appears on the right, which is what "let me draw
   * further" has to mean when the right edge was the round ending rather than
   * the screen running out.
   *
   * Not while it is running. The round has started; its length is settled.
   */
  const lengthen = useCallback((seconds: number) => {
    const { phase: ph } = live.current;
    if (ph === "running" || ph === "settled") return;
    /*
      Read from a ref, not from state.

      This runs twenty times a second and each step is computed from the last,
      so it cannot wait for a render to tell it where it got to. The rescale
      used to live inside the state updater, which React is free to run twice —
      and that halved the drawing's width in one step instead of nudging it.
    */
    // Kept as a fraction of a candle, so growth is continuous rather than a
    // stutter of whole bars. Only the axis labels ever round it.
    const bars = barsRef.current;
    const next = Math.min(RUN_MAX, bars * RUN_GROWTH ** seconds);
    if (next <= bars) return;
    const k = bars / next;
    barsRef.current = next;
    setRunBars(next);
    setPts((p) => p.map((pt) => ({ ...pt, t: pt.t * k })));
    /**
     * And the pen's own mark moves with them.
     *
     * The pen only lays a point down once it has travelled a little since the
     * last one, and it remembers where that was. Stretch the round without
     * moving that memory and it sits in the future for ever: every later point
     * looks like no progress at all, so the line stops dead at the edge and
     * nothing you do will draw again. This is the whole of "I am not able to
     * draw" — the canvas opened and the pen had already been told it was at the
     * end of it.
     */
    lastT.current *= k;
  }, []);

  /** Start a line at the live price. A finger lands wherever it lands; the
      gap is carried through the whole drawing. */
  const begin = (pt: Pt) => {
    fold();
    kept.current = 0;
    lastT.current = -1;
    anchor.current = price - pt.price;
    setResult(null);
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
      setPts((p) => {
        const i = p.findIndex((q) => q.t > pt.t);
        const index = i === -1 ? p.length : i;
        dragIndex.current = index;
        return [...p.slice(0, index), { t: pt.t, price: pt.price + offset }, ...p.slice(index)];
      });
      return;
    }
    if (phase === "running") return;
    begin(pt);
    setPts([{ t: 0, price }, { t: Math.max(pt.t, 0.03), price }]);
    dragIndex.current = 1;
    setPhase("drawing");
  };

  const onMove = (pt: Pt) => {
    const i = dragIndex.current;
    if (i !== null) {
      // Moving a point: both axes, held between its neighbours in time. While
      // the line rides the price the stored shape is offset from today.
      const offset = phase === "drawn" ? pts[0].price - price : 0;
      setPts((p) => {
        if (!p[i]) return p;
        const t = i === p.length - 1 && phase === "drawing" ? Math.max(pt.t, 0.03) : clampT(pt.t, i, p);
        return p.map((q, j) => (j === i ? { t, price: pt.price + offset } : q));
      });
    }
  };

  const onUp = () => {
    dragIndex.current = null;
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
    const moved = view;
    setPts(moved);
    setEntry(price);
    follow.current = -0.12 + Math.random() * 0.62;
    const sketch: Sketch = { id: `sk-${Date.now()}`, long: shape.long, stake, leverage, entry: price, pts: moved, placedAt: Date.now(), status: "running", net: 0 };
    setLastSketch(sketch);
    setSketches((list) => [sketch, ...list]);
    setRun([]);
    setPhase("running");
    toastManager.add({ title: `Drawn in for $${usd(stake, 0)}`, description: `${market.name} going ${shape.long ? "up" : "down"} from $${fmtPrice(price)}. It's playing out now.` });
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

  const headLabel = shape && quote ? `+$${usd(quote.ifWorks, 0)} if it gets here` : null;

  const shown = useMemo(
    () => (phase === "running" && book ? sketches.map((s) => (s.status === "running" ? { ...s, net: book.net } : s)) : sketches),
    [sketches, book, phase],
  );

  return (
    <section aria-label="Draw" className="m-2 flex min-h-[24rem] flex-1 flex-col overflow-hidden rounded-2xl border bg-background">
      {/* The tools sit with the market, on the left, rather than across the row
          from it. They belong to the line you are about to draw, and the line
          starts at the left of the chart — not in the far corner of the header,
          a screen's width from anything they act on. */}
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <MarketHeader market={{ ...market, price, change: price - prev, changePct: ((price - prev) / prev) * 100 }} />
        {phase === "live" || phase === "drawing" || phase === "drawn" ? (
          <DrawTools canUndo={pts.length > 1} onClear={onClear} onPreset={onPreset} onUndo={onUndo} />
        ) : null}
      </div>
      <div className="min-h-0 flex-1 px-2 pt-2">
        <SketchCanvas
          band={band}
          feed={feed}
          headLabel={headLabel}
          horizonMinutes={Math.round(runBars)}
          editableFrom={editableFrom}
          onDown={onDown}
          onExtend={lengthen}
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
          accuracy={accuracy}
          ghost={ghost}
          ribbon={ribbon}
        />
      </div>
      {/* The bar takes its row; the plot above it is never covered. */}
      <div className="border-t px-3 py-3">
        <SketchBar
          entry={entryView}
          leverage={leverage}
          market={market}
          onCloseNow={() => run.length && finish(run, true)}
          onDrawAgain={() => {
            fold();
            setPhase("live");
          }}
          onLeverage={setLeverage}
          onOpenList={() => setListOpen(true)}
          onPlace={onPlace}
          onStake={setStake}
          openCount={sketches.length}
          phase={phase}
          pnl={book?.net ?? null}
          price={price}
          quote={quote}
          result={result}
          runCount={run.length}
          runBars={runBars}
          shape={shape}
          sketch={lastSketch}
          sketches={shown}
          stake={stake}
        />
      </div>
      <SketchesSheet market={market} onOpenChange={setListOpen} open={listOpen} sketches={shown} />
    </section>
  );
}
