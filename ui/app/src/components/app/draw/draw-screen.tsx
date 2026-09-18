"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { toastManager } from "@/components/ui/toast";
import { type Candle, candlesFor, price as fmtPrice, type Market, signedUsd, usd } from "@/lib/market";
import { extend, nextCandle, type Outcome, type Pt, quote as quoteFor, SAMPLES, settle, shapeOf } from "@/lib/sketch";
import { MarketHeader } from "../market-header";
import { DrawTools, type Preset, type Tool } from "./draw-tools";
import type { Order } from "../ticket";
import { type Band, type Phase, SketchCanvas } from "./sketch-canvas";
import { type Result, SketchTray, VERDICT } from "./sketch-tray";
import { seedSketches, type Sketch, SketchesSheet, SketchList } from "./sketches";

/**
 * Draw. The chart, the line you put on it, what the line is worth.
 * The feed is simulated, one candle a second, pulled toward the line by a
 * factor rolled once per sketch. Swap the feed and the rest stays.
 */

const HISTORY = 46;
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

export function DrawScreen({ market, order, patch }: { market: Market; order: Order; patch: (next: Partial<Order>) => void }) {
  const stake = Number.parseFloat(order.pay) || 100;
  const leverage = order.leverage;
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
  const shape = useMemo(() => shapeOf(pts, entry), [pts, entry]);
  const quote = useMemo(() => (shape ? quoteFor(shape, entry, stake, leverage) : null), [shape, entry, stake, leverage]);
  const book = useMemo(() => (shape && run.length > 0 ? settle(run, shape, entry, stake, leverage) : null), [run, shape, entry, stake, leverage]);

  const live = useRef({ phase, shape, run, feed, entry, stake, leverage });
  useEffect(() => {
    live.current = { phase, shape, run, feed, entry, stake, leverage };
  });

  const finish = useCallback((bars: Candle[], early: boolean) => {
    const { shape: sh, entry: en, stake: st, leverage: lev } = live.current;
    if (!sh) return;
    const bk = settle(bars, sh, en, st, lev);
    const done: Outcome = bk.done ?? "time";
    const res: Result = { net: bk.net, outcome: early && bk.done === null ? "closed" : done, entry: en, exit: bk.exit, long: sh.long };
    setResult(res);
    toastManager.add({ title: VERDICT[res.outcome], description: `${signedUsd(bk.net)} on $${usd(st, 0)}`, type: bk.net >= 0 ? "success" : "error" });
    const settled = (s: Sketch): Sketch => ({ ...s, status: "settled", net: bk.net, exit: bk.exit, liquidated: done === "liquidated" });
    setSketches((list) => list.map((s) => (s.status === "running" ? settled(s) : s)));
    setLastSketch((s) => (s ? settled(s) : s));
    setFeed((f) => [...f, ...bars].slice(-HISTORY));
    setRun([]);
    setPts([]);
    setPhase("settled");
  }, []);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const tick = setInterval(() => {
      const { phase: ph, shape: sh, run: rn, feed: fd, entry: en } = live.current;
      const now = Date.now();
      if (ph !== "running" || !sh) {
        const next = [...fd.slice(1), nextCandle(fd.at(-1)?.c ?? en, VOL, now)];
        setFeed(next);
        setBand((b) => easeBand(b, bandFor(next, next.at(-1)?.c ?? en, sh ? sh.prices : [])));
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
    kept.current = 0;
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
    setPts((p) => [...p, shifted(pt)]);
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
    setPts((p) => {
      if (p.length < 2) return p;
      const n = p.length - 1;
      const shift = to - p[n].price;
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
    setPts([]);
    setResult(null);
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
    setResult(null);
    setEntry(price);
    setPts(ms.map((m, i) => ({ t: i / (ms.length - 1), price: price + m * amp })));
    kept.current = ms.length;
    setPhase("drawn");
  };

  const onPlace = () => {
    if (!shape) return;
    const shift = price - entry;
    const moved = pts.map((p) => ({ ...p, price: p.price + shift }));
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

  const shown = useMemo(
    () => (phase === "running" && book ? sketches.map((s) => (s.status === "running" ? { ...s, net: book.net } : s)) : sketches),
    [sketches, book, phase],
  );

  return (
    <div className="flex min-h-0 flex-col gap-3 lg:h-[calc(100svh-4.5rem)] lg:flex-row">
      <Card aria-label="Price" className="min-h-[16rem] min-w-0 flex-1 gap-2 p-3" render={<section />}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <MarketHeader
            market={{ ...market, price, change: price - prev, changePct: ((price - prev) / prev) * 100 }}
          />
          {phase === "live" || phase === "drawing" || phase === "drawn" ? (
            <DrawTools canUndo={pts.length > 1} onClear={onClear} onPreset={onPreset} onTool={setTool} onUndo={onUndo} tool={tool} />
          ) : null}
        </div>
        <div className="min-h-0 flex-1">
          <SketchCanvas band={band} feed={feed} onDown={onDown} onHead={onHead} onMove={onMove} onUp={onUp} phase={phase} pnl={book?.net ?? null} price={price} pts={pts} run={run} runBars={RUN_BARS} shape={shape} />
        </div>
      </Card>

      <Card aria-label="Your sketch" className="max-h-[55svh] shrink-0 gap-6 overflow-y-auto p-4 lg:max-h-none lg:w-[22rem]" render={<aside />}>
        <SketchTray
          entry={entry}
          market={market}
          onCloseNow={() => run.length && finish(run, true)}
          onDrawAgain={() => {
            setPts([]);
            setResult(null);
            setPhase("live");
          }}
          onOpenList={() => setListOpen(true)}
          onPlace={onPlace}
          openCount={sketches.length}
          order={order}
          patch={patch}
          phase={phase}
          pnl={book?.net ?? null}
          price={price}
          quote={quote}
          result={result}
          shape={shape}
          sketch={lastSketch}
        />
        {phase !== "drawn" ? (
          <div className="hidden lg:block">
            <p className="px-2 pb-1 font-medium text-muted-foreground text-xs">Your lines</p>
            <SketchList sketches={shown} />
          </div>
        ) : null}
      </Card>

      <SketchesSheet market={market} onOpenChange={setListOpen} open={listOpen} sketches={shown} />
    </div>
  );
}
