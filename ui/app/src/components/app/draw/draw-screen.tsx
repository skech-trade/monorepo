"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toastManager } from "@/components/ui/toast";
import { type Candle, candlesFor, price as fmtPrice, type Market, signedUsd, usd } from "@/lib/market";
import { accuracyOf, extend, nextCandle, type Outcome, type Pt, quote as quoteFor, ribbonFor, SAMPLES, settle, shapeOf, verdictWord } from "@/lib/sketch";
import { MarketHeader } from "../market-header";
import { DrawTools, type Preset, type Tool } from "./draw-tools";
import { type Band, type Phase, SketchCanvas } from "./sketch-canvas";
import { type Result, SketchBar } from "./sketch-tray";
import { seedSketches, type Sketch, SketchesSheet } from "./sketches";

/**
 * Draw. The chart, the line you put on it, what the line is worth.
 * The feed is simulated, one candle a second, pulled toward the line by a
 * factor rolled once per sketch. Swap the feed and the rest stays.
 */

const HISTORY = 46;
/** Candles a sketch gets. On one-minute bars that is the horizon in minutes. */
const RUN_BARS = 24;
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
  const [pts, setPts] = useState<Pt[]>([]);
  const [feed, setFeed] = useState<Candle[]>(seed);
  const [run, setRun] = useState<Candle[]>([]);
  const [entry, setEntry] = useState(market.price);
  const [band, setBand] = useState<Band>(() => bandFor(seed, market.price));
  const [result, setResult] = useState<Result | null>(null);
  const [sketches, setSketches] = useState<Sketch[]>(() => seedSketches(market));
  const [listOpen, setListOpen] = useState(false);
  const [lastSketch, setLastSketch] = useState<Sketch | null>(null);
  const [tool, setTool] = useState<Tool>("pen");

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
  const accuracy = useMemo(() => (shape && run.length > 0 ? accuracyOf(run, shape.prices, ribbon, RUN_BARS) : null), [run, shape, ribbon]);
  /** Your last line, moved to today's price. */
  const ghost = useMemo(
    () => (lastSketch && phase === "live" ? lastSketch.pts.map((p) => ({ t: p.t, price: p.price + (price - lastSketch.entry) })) : null),
    [lastSketch, phase, price],
  );
  const streamed = useRef(0);

  const live = useRef({ phase, shape, run, feed, entry, stake, leverage, ribbon });
  useEffect(() => {
    live.current = { phase, shape, run, feed, entry, stake, leverage, ribbon };
  });

  const finish = useCallback((bars: Candle[], early: boolean) => {
    const { shape: sh, entry: en, stake: st, leverage: lev, ribbon: rb } = live.current;
    if (!sh) return;
    const bk = settle(bars, sh, en, st, lev);
    const acc = accuracyOf(bars, sh.prices, rb, RUN_BARS);
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
      const along = sh.prices[Math.min(SAMPLES - 1, Math.round(((rn.length + 1) / RUN_BARS) * (SAMPLES - 1)))];
      const bar = nextCandle(open, VOL, now, along, follow.current);
      const next = [...rn, bar];
      setRun(next);
      setBand((b) => easeBand(b, bandFor([...fd, ...next].slice(-HISTORY), bar.c, sh.prices)));
      const bk = settle(next, sh, en, live.current.stake, live.current.leverage);
      if (bk.done !== null || next.length >= RUN_BARS) finish(next, false);
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

  /** Start a line at the live price. A finger lands wherever it lands; the
      gap is carried through the whole drawing. */
  const begin = (pt: Pt) => {
    fold();
    kept.current = 0;
    streamed.current = 0;
    lastT.current = -1;
    anchor.current = price - pt.price;
    setResult(null);
    setEntry(price);
    setPts([{ t: 0, price }]);
  };
  const shifted = (pt: Pt): Pt => ({ t: pt.t, price: pt.price + anchor.current });

  const onDown = (pt: Pt) => {
    if (tool === "points" && phase === "drawn" && pts.length > 1) {
      // Another turn. Time only goes one way.
      const last = pts[pts.length - 1];
      if (pt.t <= last.t + 0.02) return;
      setPts((p) => [...p, shifted(pt)]);
      return;
    }
    begin(pt);
    if (tool === "points") {
      setPts([{ t: 0, price }, { t: Math.max(pt.t, 0.03), price }]);
      kept.current = 3;
    }
    setPhase("drawing");
  };

  const onMove = (pt: Pt) => {
    if (tool === "line") {
      setPts((p) => [p[0], shifted({ t: Math.max(pt.t, 0.03), price: pt.price })]);
      kept.current = 3;
      return;
    }
    if (tool === "points") {
      setPts((p) => [...p.slice(0, -1), shifted({ t: Math.max(pt.t, 0.03), price: pt.price })]);
      return;
    }
    if (pt.t - lastT.current < 0.012) return;
    lastT.current = pt.t;
    kept.current += 1;
    // Streamline: the line lags the finger a little, so a shaky hand draws a
    // calm line. Half way to the pointer each sample, the way Excalidraw does.
    const target = shifted(pt);
    setPts((p) => {
      const last = p[p.length - 1];
      const eased = last ? last.price + (target.price - last.price) * 0.55 : target.price;
      return [...p, { t: target.t, price: eased }];
    });
  };

  const onUp = () => {
    if (phase !== "drawing") return;
    const sh = shapeOf(pts, entry);
    if (kept.current < 3 || !sh || sh.flat) {
      if (tool !== "points") {
        setPts([]);
        setPhase("live");
        return;
      }
    }
    setPhase("drawn");
  };

  /** Drag the head: the tail follows with a cubic falloff, the start holds. */
  const onHead = (to: number) => {
    // `to` is in today's prices; the stored shape may sit at the price it
    // was drawn at, so the move is measured against the ridden head.
    const headNow = view[view.length - 1]?.price ?? to;
    setPts((p) => {
      if (p.length < 2) return p;
      const n = p.length - 1;
      const shift = to - headNow;
      return p.map((pt, i) => (i === 0 ? pt : { ...pt, price: pt.price + (i / n) ** 3 * shift }));
    });
  };

  const onUndo = () => {
    setPts((p) => {
      const next = tool === "pen" ? p.slice(0, Math.max(1, p.length - Math.ceil((p.length - 1) / 3))) : p.slice(0, -1);
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
    const SHAPES: Record<Preset, number[]> = {
      "dip-rip": [0, -0.3, -0.6, -0.7, -0.45, 0, 0.5, 0.95, 1.25, 1.45],
      "straight-up": [0, 0.15, 0.3, 0.45, 0.6, 0.75, 0.9, 1.05, 1.2, 1.35],
      bleed: [0, -0.2, -0.35, -0.55, -0.7, -0.9, -1.0, -1.15, -1.25, -1.4],
    };
    const ms = SHAPES[preset];
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
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
        <MarketHeader market={{ ...market, price, change: price - prev, changePct: ((price - prev) / prev) * 100 }} />
        {phase === "live" || phase === "drawing" || phase === "drawn" ? (
          <DrawTools canUndo={pts.length > 1} onClear={onClear} onPreset={onPreset} onTool={setTool} onUndo={onUndo} tool={tool} />
        ) : null}
      </div>
      <div className="min-h-0 flex-1 px-2 pt-2">
        <SketchCanvas
          band={band}
          feed={feed}
          headLabel={headLabel}
          horizonMinutes={RUN_BARS}
          onDown={onDown}
          onHead={onHead}
          onMove={onMove}
          onUp={onUp}
          phase={phase}
          pnl={book?.net ?? null}
          price={price}
          pts={view}
          run={run}
          runBars={RUN_BARS}
          shape={shape}
          showPoints={tool === "points" && phase === "drawn"}
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
          runBars={RUN_BARS}
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
