"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toastManager } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import {
  type Candle,
  candlesFor,
  price as fmtPrice,
  type Market,
  signedUsd,
  usd,
} from "./market";
import { MarketHeader } from "./market-header";
import type { Order } from "./order-ticket";
import {
  extend,
  nextCandle,
  type Outcome,
  type Pt,
  quote as quoteFor,
  SAMPLES,
  settle,
  shapeOf,
} from "./sketch";
import { type Band, type Phase, SketchCanvas } from "./sketch-canvas";
import { type Result, SketchSheet, VERDICT } from "./sketch-sheet";
import {
  seedSketches,
  type Sketch,
  SketchesDialog,
  SketchList,
} from "./sketches";

/**
 * Draw. The chart, the line you put on it, and what that line is worth.
 *
 * This is the landing page's hero canvas made into the product. The landing
 * runs the drag and settles the trade on release; here there is a step in
 * between, because it is money: the line comes down, the sheet quotes it in
 * two dollar figures, you set how much, then you press. The chart never goes
 * away under the sheet. Fomo's confirmation screen hides the chart and its
 * reviews say so.
 *
 * The clock is a simulation, one candle a second, pulled toward your line by
 * a factor rolled once per sketch. It is a preview of the interface and the
 * captions say so. Swap the feed for a live one and the drawing, the quote
 * and the settlement stay as they are.
 */

const HISTORY = 46;
/** Candles a placed sketch gets before it settles where it stands. */
const RUN_BARS = 24;
const TICK_MS = 1000;
const SUB_MS = 80;
const VOL = 0.0016;

function bandFor(candles: Candle[], center: number, extra: number[] = []): Band {
  let reach = center * 0.012;
  for (const c of candles) {
    reach = Math.max(reach, Math.abs(c.h - center), Math.abs(c.l - center));
  }
  for (const p of extra) reach = Math.max(reach, Math.abs(p - center));
  const pad = reach * 1.2;
  return { lo: center - pad, hi: center + pad };
}

/** Chase the band rather than snap to it, so one wick does not jolt the chart. */
function easeBand(from: Band, to: Band): Band {
  const k = 0.12;
  return {
    lo: from.lo + (to.lo - from.lo) * k,
    hi: from.hi + (to.hi - from.hi) * k,
  };
}

export function DrawScreen({
  market,
  order,
  patch,
  className,
}: {
  market: Market;
  order: Order;
  patch: (next: Partial<Order>) => void;
  className?: string;
}) {
  const stake = Number.parseFloat(order.pay) || 100;
  const leverage = order.leverage;

  const seed = useMemo(
    () => candlesFor(market, "1m").slice(-HISTORY),
    [market],
  );

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

  /** How much this market respects the line. Rolled once per sketch. */
  const follow = useRef(0);
  const lastT = useRef(-1);
  const kept = useRef(0);

  const price = run.at(-1)?.c ?? feed.at(-1)?.c ?? market.price;
  /** Yesterday's close, so today's move follows the live price. */
  const prev = market.price - market.change;
  const shape = useMemo(() => shapeOf(pts, entry), [pts, entry]);
  const quote = useMemo(
    () => (shape ? quoteFor(shape, entry, stake, leverage) : null),
    [shape, entry, stake, leverage],
  );
  const book = useMemo(
    () =>
      shape && run.length > 0 ? settle(run, shape, entry, stake, leverage) : null,
    [run, shape, entry, stake, leverage],
  );

  /* ---- the clock ---------------------------------------------------------- */

  const live = useRef({ phase, shape, run, feed, entry, stake, leverage });
  useEffect(() => {
    live.current = { phase, shape, run, feed, entry, stake, leverage };
  });

  const finish = useCallback((bars: Candle[], early: boolean) => {
    const { shape: sh, entry: en, stake: st, leverage: lev } = live.current;
    if (!sh) return;
    const bk = settle(bars, sh, en, st, lev);
    const done: Outcome = bk.done ?? "time";
    const res: Result = {
      net: bk.net,
      outcome: early && bk.done === null ? "closed" : done,
      entry: en,
      exit: bk.exit,
      long: sh.long,
    };
    setResult(res);
    toastManager.add({
      description: `${signedUsd(bk.net)} on $${usd(st, 0)}`,
      title: VERDICT[res.outcome],
      type: bk.net >= 0 ? "success" : "error",
    });
    const settled = (s: Sketch): Sketch => ({
      ...s,
      status: "settled",
      net: bk.net,
      exit: bk.exit,
      liquidated: done === "liquidated",
    });
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
        setBand((b) =>
          easeBand(b, bandFor(next, next.at(-1)?.c ?? en, sh ? sh.prices : [])),
        );
        return;
      }

      const open = rn.at(-1)?.c ?? en;
      const along =
        sh.prices[
          Math.min(
            SAMPLES - 1,
            Math.round(((rn.length + 1) / RUN_BARS) * (SAMPLES - 1)),
          )
        ];
      const bar = nextCandle(open, VOL, now, along, follow.current);
      const next = [...rn, bar];
      setRun(next);
      setBand((b) => easeBand(b, bandFor([...fd, ...next].slice(-HISTORY), bar.c, sh.prices)));

      const bk = settle(next, sh, en, live.current.stake, live.current.leverage);
      if (bk.done !== null || next.length >= RUN_BARS) finish(next, false);
    }, TICK_MS);

    const sub = setInterval(() => {
      const { phase: ph, run: rn } = live.current;
      if (ph === "running" && rn.length) {
        setRun((r) => (r.length ? [...r.slice(0, -1), extend(r[r.length - 1], VOL)] : r));
      } else {
        setFeed((f) => (f.length ? [...f.slice(0, -1), extend(f[f.length - 1], VOL)] : f));
      }
    }, SUB_MS);

    return () => {
      clearInterval(tick);
      clearInterval(sub);
    };
  }, [finish]);

  /* ---- drawing ------------------------------------------------------------ */

  /**
   * The line starts where you get in, which is the live price, and a finger
   * lands wherever it lands. The gap between the two is carried through the
   * whole drawing, so the shape is yours and the start is the market's.
   */
  const anchor = useRef(0);

  const onDraw = (pt: Pt, first: boolean) => {
    if (first) {
      kept.current = 0;
      lastT.current = -1;
      anchor.current = price - pt.price;
      setResult(null);
      setEntry(price);
      setPts([{ t: 0, price }]);
      setPhase("drawing");
      return;
    }
    // Time only goes one way, and points closer than this are the same point.
    if (pt.t - lastT.current < 0.012) return;
    lastT.current = pt.t;
    kept.current += 1;
    setPts((prev) => [...prev, { t: pt.t, price: pt.price + anchor.current }]);
  };

  const onDrawEnd = () => {
    if (kept.current < 3) {
      setPts([]);
      setPhase("live");
      return;
    }
    const sh = shapeOf(pts, entry);
    if (!sh || sh.flat) {
      setPts([]);
      setPhase("live");
      return;
    }
    setPhase("drawn");
  };

  const onPlace = () => {
    if (!shape) return;
    // The line starts where you get in, which is now. Whatever the price did
    // while you were reading the quote, the start moves with it.
    const shift = price - entry;
    const moved = pts.map((p) => ({ ...p, price: p.price + shift }));
    setPts(moved);
    setEntry(price);
    follow.current = -0.12 + Math.random() * 0.62;
    const sketch: Sketch = {
      id: `sk-${Date.now()}`,
      long: shape.long,
      stake,
      leverage,
      entry: price,
      pts: moved,
      placedAt: Date.now(),
      status: "running",
      net: 0,
    };
    setLastSketch(sketch);
    setSketches((list) => [sketch, ...list]);
    setRun([]);
    setPhase("running");
    toastManager.add({
      description: `${market.name} going ${shape.long ? "up" : "down"} from $${fmtPrice(price)}. It's playing out now.`,
      title: `Drawn in for $${usd(stake, 0)}`,
    });
  };

  const onDrawAgain = () => {
    setPts([]);
    setResult(null);
    setPhase("live");
  };

  const onCloseNow = () => {
    if (run.length === 0) return;
    finish(run, true);
  };

  // The running row reads its figure off the book, not off stored state.
  const shown = useMemo(
    () =>
      phase === "running" && book
        ? sketches.map((s) =>
            s.status === "running" ? { ...s, net: book.net } : s,
          )
        : sketches,
    [sketches, book, phase],
  );

  return (
    <div
      className={cn(
        "flex min-h-0 flex-col gap-3 lg:flex-row lg:gap-4",
        className,
      )}
    >
      <section
        aria-label="Price"
        className="panel flex min-h-[14rem] min-w-0 flex-1 flex-col rounded-4xl p-3"
      >
        {/* The header reads the same price as the chart. A header that says
            one number over a tag that says another is the fastest way to make
            a screen look fake. */}
        <MarketHeader
          className="pb-2"
          market={{
            ...market,
            price,
            change: price - prev,
            changePct: ((price - prev) / prev) * 100,
          }}
          variant="inline"
        />
        <div className="min-h-0 flex-1">
          <SketchCanvas
            band={band}
            feed={feed}
            onDraw={onDraw}
            onDrawEnd={onDrawEnd}
            phase={phase}
            pnl={book?.net ?? null}
            price={price}
            pts={pts}
            run={run}
            runBars={RUN_BARS}
            shape={shape}
          />
        </div>
      </section>

      {/*
        The tray. Under the chart on a phone, within reach of a thumb; a
        column beside it on a desk. It grows as the sketch progresses and the
        chart gives up the height, which is how a stack of trays says "you are
        further along" without a step counter.
      */}
      <aside
        aria-label="Your sketch"
        className="panel max-h-[55svh] shrink-0 overflow-y-auto rounded-4xl p-4 sm:p-5 lg:max-h-none lg:w-[24rem]"
      >
        <SketchSheet
          entry={entry}
          market={market}
          onCloseNow={onCloseNow}
          onDrawAgain={onDrawAgain}
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

        {/* On a desk the column has the room, so the list lives in it. On a
            phone it is behind the button, in a sheet. */}
        {phase !== "drawn" ? (
          <div className="mt-6 hidden lg:block">
            <p className="px-3 pb-1 text-kicker text-fg-subtle">Your lines</p>
            <SketchList sketches={shown} />
          </div>
        ) : null}
      </aside>

      <SketchesDialog
        market={market}
        onOpenChange={setListOpen}
        open={listOpen}
        sketches={shown}
      />
    </div>
  );
}
