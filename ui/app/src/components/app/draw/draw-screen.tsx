"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CANDLE_SECONDS, useFeed } from "@/lib/feed";
import { closeExistingPosition, closeRound, editRound, hasTrader, keyFor, openRound, prepareKey, prepareRound, registerKey, type RoundSpec, skipSegment, useVenueRound, useVenueHistory, type VenueRound } from "@/lib/round";
import { usePhone } from "@/lib/phone";
import { usePlayer } from "@/lib/social";
import { useProfile } from "@/lib/profile";
import { useAccount } from "../auth";
import { useSettings } from "@/lib/settings";
import { type Candle, type Market, marketBySymbol } from "@/lib/market";
import Link from "next/link";
import { chartPnl } from "@/lib/chart-pnl";
import { accuracyOf, type Exits, type Outcome, type Pt, quote as quoteFor, ribbonFor, SAMPLES, shapeOf, simplify } from "@/lib/sketch";
import { NETWORK } from "@/lib/venue";
import { MarketHeader } from "../market-header";
import { PlaceTicket } from "./place-ticket";
import { DrawTools, type Preset, PRESETS } from "./draw-tools";
import { PhoneTools } from "./phone-tools";
import { HistoryIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { type Band, type Phase, type SegmentMark, SketchCanvas, type TradeMark } from "./sketch-canvas";
import { SketchBar } from "./sketch-tray";
import { RoundsSheet, type Sketch } from "./sketches";

/** Draw against real venue candles and show only confirmed venue P&L. */

export const HISTORY = 180;
/** A candle spans 500ms; 120 candles make a minute. Drawing off the right edge lengthens it. */
const RUN_BARS = 120;
/** The shortest round is ten candles. Five seconds is a coin toss, not a call. */
const MIN_BARS = 10;

/** How long a round this line makes: its last second, never shorter than MIN_BARS. */
const barsFor = (pts: Pt[], horizon: number) => Math.max(MIN_BARS, Math.round((pts[pts.length - 1]?.t ?? 1) * horizon * CANDLE_SECONDS) / CANDLE_SECONDS);
/** As long as a sketch may get. Five minutes is already a long wait. */
export const RUN_MAX = 600;

/**
 * Every point at the same moment on a round `k` times as long, never past its
 * end. How a line keeps its shape in time when the round under it grows or
 * shrinks: `t` is a fraction of the round, so a longer round means smaller t.
 */
const rescale = (pts: Pt[], k: number): Pt[] => pts.map((p) => ({ ...p, t: Math.min(1, p.t * k) }));

/** A round the trader holds, as the cards and the sheet show it. */
function sketchFromVenue(r: VenueRound, previous: Sketch | undefined, chartBased: boolean): Sketch {
  const pts = r.pts ?? [];
  // On testnet the chart values the round's real trades; the venue's figure only once it is booked.
  const net =
    chartBased && r.trades?.length && r.bars?.length
      ? chartPnl(r.trades, r.orders ?? [], r.bars, r.bars.at(-1)!.c).net
      : r.pnlReady
        ? (r.net ?? r.realised)
        : 0;
  return {
    ...previous,
    id: r.id,
    venueId: r.id,
    pts,
    entry: r.entry,
    stake: r.stake,
    leverage: r.leverage,
    placedAt: r.startedAt,
    long: shapeOf(pts, r.chartEntry ?? r.entry)?.long ?? true,
    status: r.status === "done" ? "settled" : "running",
    net,
    pnlReady: r.pnlReady,
    exit: r.exit,
    run: previous?.run ?? r.bars,
    runBars: r.seconds / CANDLE_SECONDS,
  };
}

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

export function DrawScreen({ market, stream }: { market: Market; stream: ReturnType<typeof useFeed> }) {
  /* What you put in last. A round that resets to the default every time makes
     you set the same two figures before every line you draw. */
  const [{ stake, leverage }, setSettings] = useSettings();
  const setStake = (next: number) => setSettings({ stake: next });
  const setLeverage = (next: number) => setSettings({ leverage: next });
  /** Where to get out, in dollars. Both optional; empty means neither. */
  const [exits, setExits] = useState<Exits>({ lose: null, gain: null });
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
  const [feed, setFeed] = useState<Candle[]>(() => stream?.bars.slice(-HISTORY) ?? []);
  const [run, setRun] = useState<Candle[]>([]);
  const [entry, setEntry] = useState(market.price);
  const [band, setBand] = useState<Band>(() => bandFor([], market.price || 1));
  const [sketches, setSketches] = useState<Sketch[]>([]);
  const [listOpen, setListOpen] = useState(false);
  /*
    The round on the venue, when there is a trader to run one.

    Its id is all this screen keeps: the position, the profit and the way it
    ended are the venue's to say, and asking is the only way to know them.
  */
  const [venueId, setVenueId] = useState<string | null>(null);
  /* Why the last thing asked of the trader did not happen, in its words. */
  const [venueProblem, setVenueProblem] = useState<string | null>(null);
  const venue = useVenueRound(venueId);
  /* Whose account the orders land on, against whose balance is on the screen. */
  const me = useAccount();
  const profile = useProfile(me.address);
  const social = usePlayer(me.address, me.signMessage);
  const mine = profile.balance?.accountIndex ?? null;
  /* A round that landed on any account but the reader's own would be a bug,
     not a mode. This is the check that says so if it ever happens again. */
  const notMine = venue !== null && mine !== null && venue.accountIndex !== mine;
  const [lastSketch, setLastSketch] = useState<Sketch | null>(null);
  /** The point under the finger, while one is. */
  const dragIndex = useRef<number | null>(null);
  /** Where the finger landed, for a tap that becomes a point. */
  const tapAt = useRef<Pt | null>(null);

  /** Where a new bar from the stream goes. */
  const arriving = useRef<(bar: Candle) => void>(() => undefined);

  const [placing, setPlacing] = useState(false);
  /** Click to venue acknowledgement for the last open, measured in this browser. */
  const [openedIn, setOpenedIn] = useState<number | null>(null);
  const [closeRequested, setCloseRequested] = useState(false);
  const placementLock = useRef(false);
  /* Every market's rounds, for the one that blocks a new trade wherever it runs; this market's, for the chart. */
  const everyRound = useVenueHistory(mine);
  const history = useMemo(() => everyRound.filter((r) => (r.market ?? "BTC") === market.symbol), [everyRound, market.symbol]);
  /** A round still running on the other market. The account trades one at a time. */
  const elsewhere = everyRound.find((r) => r.status !== "done" && (r.market ?? "BTC") !== market.symbol);
  const elsewhereMarket = elsewhere ? marketBySymbol(elsewhere.market ?? "BTC") : null;
  const lastT = useRef(-1);
  const kept = useRef(0);
  const anchor = useRef(0);

  /* The live price follows the book's mid, which moves many times between
     trades; the candles stay trades. Settled, the picture stops where it ended. */
  const mid = phase !== "settled" && stream?.connected ? stream.quote?.mid : undefined;
  const price = mid || (run.at(-1)?.c ?? feed.at(-1)?.c ?? market.price);
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
  /*
    Whose P&L the screen shows. On mainnet the venue's, always. On testnet
    the venue's book is a quote that does not move, so its P&L is the spread
    and nothing else; there the screen values the same real trades at the
    chart's price, says so, and keeps the venue's figure beside it.
  */
  const chartBased = NETWORK === "testnet";
  const candlesAll = useMemo(() => [...feed, ...run], [feed, run]);
  const chart = useMemo(() => (venue?.trades?.length ? chartPnl(venue.trades, venue.orders ?? [], candlesAll, price) : null), [venue, candlesAll, price]);
  const net = chartBased ? (chart?.trades.length ? chart.net : null) : venue?.pnlReady ? venue.net : null;
  const openChart = chart?.trades.find((t) => t.to === null) ?? null;
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

  const finish = useCallback((bars: Candle[], result: VenueRound) => {
    const { shape: sh, runBars: rbars } = live.current;
    if (!sh) {
      setPhase("settled");
      setListOpen(true);
      return;
    }

    const acc = accuracyOf(bars, sh.prices, rbars);
    const outcome: Outcome = result.outcome === "stop" || result.outcome === "target" ? result.outcome : "time";
    // The round is kept whole on its record: what arrived, how long it was, how it ended. That is what replays and exports.
    const booked =
      chartBased && result.trades?.length
        ? chartPnl(result.trades, result.orders ?? [], [...live.current.feed, ...bars], bars.at(-1)?.c ?? null).net
        : result.realised;
    const settled = (s: Sketch): Sketch => ({
      ...s,
      status: "settled",
      net: booked,
      pnlReady: result.pnlReady,
      exit: result.exit,
      venueId: result.id,
      right: acc.right,
      outcome,
      run: bars,
      runBars: rbars,
    });
    setSketches((list) => list.map((s) => (s.status === "running" ? settled(s) : s)));
    setLastSketch((s) => (s ? settled(s) : s));
    // The round stays on screen: dashed line, coloured ribbon, the gap. It
    // folds into history when the next line starts. And the rounds sheet
    // opens on it, where every earlier round already is.
    live.current = { ...live.current, phase: "settled" };
    setPhase("settled");
    setListOpen(true);
  }, [chartBased]);

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
    const arrive = (bar: Candle) => {
      const { phase: ph, shape: sh, run: rn, feed: fd } = live.current;
      if (ph === "settled") return;
      if (ph !== "running" || !sh) {
        const next = [...fd, bar].slice(-HISTORY);
        live.current = { ...live.current, feed: next };
        setFeed(next);
        if (ph !== "drawing") setBand((b) => easeBand(b, bandFor(next, bar.c, sh ? sh.prices : [])));
        return;
      }
      const next = [...rn, bar];
      live.current = { ...live.current, run: next };
      setRun(next);
      setBand((b) => easeBand(b, bandFor([...fd, ...next].slice(-HISTORY), bar.c, sh.prices)));
      // Only venue confirmation can finish a trade or book its result.
    };
    arriving.current = arrive;

    return () => {
      arriving.current = () => undefined;
    };
  }, []);

  /* Market history includes forming-bar corrections. Only new timestamps
     advance a running round; reconnect snapshots can also repair history. */
  const seededFromMarket = useRef(false);
  const lastBucket = useRef(0);
  const latest = stream?.latest ?? null;
  useEffect(() => {
    if (!latest || !stream) return;
    if (!seededFromMarket.current) {
      seededFromMarket.current = true;
      const history = stream.bars.slice(-HISTORY);
      setFeed(history);
      const price = history.at(-1)?.c ?? latest.c;
      setEntry(price);
      setBand(bandFor(history, price));
      lastBucket.current = latest.t;
      return;
    }
    const current = live.current;
    if (current.phase === "settled") return;
    // The stream owns history, including reconnect snapshots and corrections.
    // A forming-bar update must never advance a round's clock.
    if (current.phase !== "running") {
      const history = stream.bars.slice(-HISTORY);
      live.current = { ...current, feed: history };
      setFeed(history);
      if (current.phase !== "drawing") setBand((b) => easeBand(b, bandFor(history, latest.c, current.shape?.prices ?? [])));
      lastBucket.current = latest.t;
      return;
    }
    const byTime = new Map(stream.bars.map((bar) => [bar.t, bar]));
    const corrected = current.run.map((bar) => byTime.get(bar.t) ?? bar);
    live.current = { ...current, run: corrected };
    setRun(corrected);
    if (latest.t <= lastBucket.current) return;
    const fresh = stream.bars.filter((bar) => bar.t > lastBucket.current);
    lastBucket.current = latest.t;
    for (const bar of fresh) {
      arriving.current(bar);
      if (live.current.phase === "settled") break;
    }
  }, [latest, stream]);

  /**
   * Points at or before this time have already happened. A second ahead of now, while a round
   * runs: what is closer than that has effectively happened by the time an edit reaches the venue.
   */
  const editableFrom = placing ? Infinity : phase === "running" ? Math.min(1, (run.length + 2) / runBars) : 0;
  const edited = useRef(false);
  /* Draw more: the next stroke continues the running line from its end. */
  const [extending, setExtending] = useState(false);
  const drawingMore = useRef<number | null>(null);
  /* Where the hold point sits while Draw more is on, so the stroke replaces it. */
  const holdAt = useRef<number | null>(null);
  const ptsRef = useRef(pts);
  useEffect(() => {
    ptsRef.current = pts;
  });

  /**
   * The round becomes `next` candles long, with every moment already drawn kept where it is.
   * Returns the factor each t was scaled by, for the caller to move its points with.
   */
  const resizeRound = (next: number) => {
    const k = barsRef.current / next;
    barsRef.current = next;
    setRunBars(next);
    // And the pen's own memory of where it got to.
    lastT.current = Math.min(1, lastT.current * k);
    return k;
  };

  /**
   * Make the round long enough to hold a point at this time, rescaling every t. Growing by exactly
   * the factor asked lands the head on the edge. Returns the point's new t.
   */
  const coverTo = (t: number) => {
    const bars = barsRef.current;
    if (t <= 1) return t;
    if (bars >= RUN_MAX) return 1;
    const k = resizeRound(Math.min(RUN_MAX, bars * t));
    setPts((p) => rescale(p, k));
    return Math.min(1, t * k);
  };

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
    if (placing || (phase === "running" && (pts[index]?.t ?? 0) <= editableFrom)) return;
    dragIndex.current = index;
  };

  /** A point removed. Two points is the least that is still a line. */
  const onRemove = (index: number) => {
    if (placing || (phase === "running" && (pts[index]?.t ?? 0) <= editableFrom)) return;
    if (phase === "running") edited.current = true;
    setPts((p) => {
      if (p.length <= 2) return p;
      return p.filter((_, i) => i !== index);
    });
    if (phase === "running") sendEdit();
  };

  const onDown = (pt: Pt) => {
    if (placing) return;
    if (phase === "running" && extending && pts.length > 1) {
      // A freehand stroke that continues the line from its real end, replacing the hold.
      const base = holdAt.current !== null && holdAt.current === pts.length - 1 ? pts.slice(0, -1) : pts;
      holdAt.current = null;
      drawingMore.current = base.length;
      dragIndex.current = null;
      const t = coverTo(Math.max(pt.t, base[base.length - 1].t + 0.01));
      lastT.current = t;
      edited.current = true;
      setPts([...base, { t, price: pt.price }]);
      return;
    }
    if ((phase === "drawn" || phase === "running") && pts.length > 1) {
      // Another point, where you clicked, in time order. Ahead of now only.
      if (pt.t <= editableFrom) return;
      // While the line rides the price the stored shape is offset from today.
      const offset = phase === "drawn" ? pts[0].price - price : 0;
      // Past the end grows the round, running or not: that is how a trade in
      // progress gets more positions. The trader re-plans with the new length.
      const t = coverTo(pt.t);
      if (phase === "running") edited.current = true;
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
    if (drawingMore.current !== null) {
      if (pt.t - lastT.current < 0.008) return;
      const t = coverTo(pt.t);
      lastT.current = t;
      stretchTo(pt.price);
      setPts((p) => [...p, { t, price: pt.price }]);
      return;
    }
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
      if (phase === "running") edited.current = true;
      setPts((p) => {
        if (!p[i]) return p;
        const t = i === p.length - 1 && phase === "drawing" ? Math.max(want, 0.03) : Math.max(phase === "running" ? editableFrom + 0.001 : 0, clampT(want, i, p));
        return p.map((q, j) => (j === i ? { t, price: pt.price + offset } : q));
      });
      return;
    }
    if (phase !== "drawing") return;
    // The stroke itself. A point every hundredth or so of the round, which is
    // finer than a bar and far finer than anything that can be traded, the
    // shape is what is being captured, not the samples.
    // A vertical stroke (including holding either edge) changes the tip even
    // when time has not advanced enough to append another point.
    if (pt.t - lastT.current < 0.008) {
      const nextPrice = pt.price + anchor.current;
      stretchTo(nextPrice);
      setPts((p) => p.length < 2 ? p : [...p.slice(0, -1), { ...p[p.length - 1], price: nextPrice }]);
      return;
    }
    const t = coverTo(pt.t);
    lastT.current = t;
    kept.current += 1;
    // Follow input directly. Simplification happens after release, so it
    // does not make the live stroke trail the pointer.
    const target = { t, price: pt.price + anchor.current };
    stretchTo(target.price);
    setPts((p) => [...p, target]);
  };

  /** The picture back to the plan the trader is actually running, when it refused ours. */
  const resync = (round: VenueRound | null) => {
    if (!round?.pts?.length || !round.seconds) return;
    const bars = round.seconds / CANDLE_SECONDS;
    barsRef.current = bars;
    setRunBars(bars);
    setPts(round.pts);
  };
  /*
    Draw more buys time first. The trader holds the current position for
    thirty more seconds, straight away, so the round cannot reach its old end
    while the new part is still being drawn; the stroke then replaces the
    hold. Sending the extension only on release closed rounds mid-stroke.
  */
  const extendRound = () => {
    if (!venueId || !ptsRef.current.length) return;
    const bars = barsRef.current;
    const next = Math.min(RUN_MAX, bars + 30 / CANDLE_SECONDS);
    if (next <= bars) return;
    const scaled = rescale(ptsRef.current, resizeRound(next));
    const held = [...scaled, { t: 1, price: scaled[scaled.length - 1].price }];
    holdAt.current = held.length - 1;
    setPts(held);
    setViewBars((v) => Math.max(v, Math.min(RUN_MAX, next * 1.2)));
    void editRound(venueId, held, next * CANDLE_SECONDS).then((r) => {
      if ("error" in r) {
        setVenueProblem(r.error);
        holdAt.current = null;
        setExtending(false);
        resync(venue);
      }
    });
  };
  /* Edits to a running round go to the trader, which re-plans everything
     after now and leaves what has happened alone. Coalesced, so a drag sends
     its final shape rather than every frame of it. */
  const editTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sendEdit = () => {
    if (editTimer.current) clearTimeout(editTimer.current);
    editTimer.current = setTimeout(() => {
      edited.current = false;
      if (!venueId) return;
      const started = performance.now();
      // The round ends where the line ends, so a stroke shorter than the Draw more hold shrinks it back.
      const line = ptsRef.current;
      const end = line.at(-1)?.t ?? 1;
      if (end > 0 && end < 1) {
        const trimmed = rescale(line, resizeRound(Math.max(barsRef.current * end, live.current.run.length + 1)));
        ptsRef.current = trimmed;
        setPts(trimmed);
      }
      // The chart window grows with the round, so the new end stays in view.
      setViewBars((v) => Math.max(v, barsRef.current));
      void editRound(venueId, ptsRef.current, barsRef.current * CANDLE_SECONDS).then((r) => {
        console.info(`[skech timing] plan edit applied in ${Math.round(performance.now() - started)}ms`);
        setVenueProblem("error" in r ? r.error : null);
        if ("error" in r) resync(venue);
      });
    }, 120);
  };

  const onUp = () => {
    const drew = dragIndex.current === null && phase === "drawing";
    dragIndex.current = null;
    if (drawingMore.current !== null) {
      // Settle only the new stroke into its corners; what was already drawn stays as it was.
      const from = drawingMore.current - 1;
      drawingMore.current = null;
      setExtending(false);
      setPts((p) => [...p.slice(0, from), ...simplify(p.slice(from), band.hi - band.lo, entry)]);
    }
    if (phase === "running" && edited.current) sendEdit();
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

  /*
    Open the round on the venue, registering a trading key first if this
    wallet has none.

    The key is asked for here rather than on a setup screen somewhere, because
    it is needed exactly once and exactly now. One signature, the first time
    somebody trades, and never again: it authorises a key that can trade their
    Lighter account and nothing else. It cannot move money off the venue.
  */
  /* Whether this wallet's key is known to be registered. Prepare answers it
     while the line is drawn, so a click does not spend a round trip asking. */
  const keyReady = useRef<string | null>(null);
  /** This wallet has no trading key: the button enables trading first, as its own step. */
  const [needsKey, setNeedsKey] = useState<string | null>(null);
  const [enabling, setEnabling] = useState(false);

  /** Register a trading key for this wallet: one signature. Throws `cancelled` if they decline to sign. */
  const registerTradingKey = async (address: string, cancelled: string) => {
    const prep = await prepareKey(address);
    if (prep.error) throw Error(prep.error);
    if (!prep.messageToSign) return;
    const signature = await me.signMessage(prep.messageToSign);
    if (!signature) throw Error(cancelled);
    const done = await registerKey(address, signature);
    if (done.error) throw Error(done.error);
  };

  const trade = async (address: string, spec: Omit<RoundSpec, "address">) => {
    const registered = keyReady.current === address || (await keyFor(address)).registered;
    if (!registered) await registerTradingKey(address, "Signature cancelled. No trade was placed.");
    const result = await openRound({ address, ...spec });
    if ("error" in result) {
      // A key the trader no longer has: ask again next time rather than trust the cache.
      if (result.needsKey) keyReady.current = null;
      throw Error(result.error);
    }
    keyReady.current = address;
    return result;
  };

  /*
    The one-time setup, as its own step. It used to run inside the first
    click on Trade, so a new wallet's first round opened seconds after the
    press, with the drawing's whole plan starting late by as much.
  */
  const enableTrading = async () => {
    if (!me.address || enabling) return;
    const address = me.address;
    setEnabling(true);
    setVenueProblem(null);
    const started = performance.now();
    try {
      await registerTradingKey(address, "Signature cancelled. Trading is not enabled yet.");
      keyReady.current = address;
      setNeedsKey(null);
      console.info(`[skech timing] trading enabled in ${Math.round(performance.now() - started)}ms (includes your signature)`);
      void prepareRound(address, leverage, market.symbol);
    } catch (error) {
      setVenueProblem((error as Error).message.slice(0, 180));
    } finally {
      setEnabling(false);
    }
  };

  const onPlace = async () => {
    if (placementLock.current || !shape || !hasTrader || !me.address || !stream?.connected || !stream.latest) return;
    placementLock.current = true;
    setPlacing(true);
    setVenueProblem(null);
    const clicked = performance.now();
    try {
      const horizon = barsRef.current;
      const bars = barsFor(view, horizon);
      // The round ends where the line does, so the line is stretched to fill it. Divided, not
      // `rescale`d by 1/end, so the last point lands on exactly 1.
      const end = view.at(-1)?.t ?? 1;
      const moved = end > 0 ? view.map((p) => ({ ...p, t: Math.min(1, p.t / end) })) : view;
      const seconds = bars * CANDLE_SECONDS;
      const result = await trade(me.address, { market: market.symbol, pts: moved, stake, leverage, seconds, exits });

      const took = Math.round(performance.now() - clicked);
      const t = result.timing;
      const venueAck = t?.openAckAt ? t.openAckAt - t.requestedAt : null;
      console.info(`[skech timing] open: click → venue ack ${took}ms (trader: accept ${t?.readyAt ? t.readyAt - t.requestedAt : "?"}ms, venue ack ${venueAck ?? "?"}ms)`);
      setOpenedIn(took);

      const sketch: Sketch = {
        id: result.id,
        venueId: result.id,
        author: social.player?.username ?? profile.name ?? undefined,
        long: shape.long,
        stake,
        leverage,
        entry: result.entry,
        pts: moved,
        placedAt: result.startedAt,
        status: "running",
        net: 0,
      };
      setVenueId(result.id);
      setPts(moved);
      setRunBars(bars);
      barsRef.current = bars;
      setEntry(result.chartEntry ?? result.entry);
      setLastSketch(sketch);
      setSketches((list) => [sketch, ...list]);
      // Candles from the round's start on are the round's; the ones before are history.
      setRun(live.current.feed.filter((c) => c.t >= result.startedAt));
      setFeed(live.current.feed.filter((c) => c.t < result.startedAt));
      setViewBars(horizon);
      setPhase("running");
      void social.startPrediction(moved, seconds, market.symbol);
    } catch (error) {
      setVenueProblem((error as Error).message.slice(0, 180));
    } finally {
      placementLock.current = false;
      setPlacing(false);
    }
  };

  /* While the line is being drawn, have the trader do everything a trade
     needs except send it: subscribe to this account, read its nonce, set its
     leverage. Then the button costs one round trip to the venue. */
  const address = me.address;
  const symbol = market.symbol;
  const preparing = phase === "drawing" || phase === "drawn";
  useEffect(() => {
    if (!preparing || !address || !hasTrader) return;
    const timer = setTimeout(() => {
      const started = performance.now();
      void prepareRound(address, leverage, symbol).then((r) => {
        if (r.ready) keyReady.current = address;
        setNeedsKey(r.needsKey ? address : null);
        if (r.ready) console.info(`[skech timing] prepared in ${Math.round(performance.now() - started)}ms (venue round trip ≈ ${r.latencyMs}ms)`);
      });
    }, 250);
    return () => clearTimeout(timer);
  }, [preparing, address, leverage, symbol]);

  useEffect(() => {
    const active = history.find((r) => r.status !== "done");
    if (!active || venueId) return;
    // Restore a server-owned active round after a refresh; never invent its P&L.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setVenueId(active.id);
    setPts(active.pts ?? []);
    setEntry(active.chartEntry ?? active.entry);
    setRunBars(Math.max(MIN_BARS, active.seconds / CANDLE_SECONDS));
    setPhase("running");
  }, [history, venueId]);

  useEffect(() => {
    if (venue?.status !== "done" || phase !== "running") return;
    // The line and length the trader actually traded, not a local edit it never took.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    resync(venue);
    const t = venue.timing;
    if (t?.closeRequestedAt && t.closedAt) console.info(`[skech timing] close: requested → flat ${t.closedAt - t.closeRequestedAt}ms (venue ack ${t.closeAckAt ? t.closeAckAt - t.closeRequestedAt : "?"}ms)`);
    finish(live.current.run, venue);
    window.dispatchEvent(new Event("skech-balance"));
  }, [venue, phase, finish]);

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

  /*
    What each round is worth, on the cards and in the sheet.

    A round that went to the venue is worth what the venue booked, whether it
    is still open or finished. The settled card used to show the local
    settlement whatever happened: a round that cost $39 in slippage on the
    venue read $0.00, because the simulation had nothing to settle after an
    early close. Two numbers for one round, and the wrong one on screen.
  */
  const shown = useMemo(() => {
    const byId = new Map(sketches.map((s) => [s.id, s]));
    for (const r of history) byId.set(r.id, sketchFromVenue(r, byId.get(r.id), chartBased));
    // The round being followed live is fresher than the history poll.
    const current = venue ? byId.get(venue.id) : undefined;
    if (venue && current) {
      byId.set(venue.id, {
        ...current,
        status: venue.status === "done" ? "settled" : "running",
        net: chartBased ? (current.status === "settled" ? current.net : (net ?? 0)) : venue.pnlReady ? (venue.net ?? venue.realised) : 0,
        pnlReady: venue.pnlReady,
        exit: venue.exit,
      });
    }
    return [...byId.values()].sort((a, b) => b.placedAt - a.placedAt);
  }, [sketches, history, venue, chartBased, net]);

  /* Every order the trader sent, where it was sent. Its own clock, the same one the round started on. */
  const marks = useMemo<TradeMark[]>(() => {
    if (!venue?.orders?.length || !venue.seconds) return [];
    const span = venue.seconds * 1000;
    return venue.orders.filter((o) => o.kind !== undefined).map((o) => {
      const sent = o.sentAt ?? o.requestedAt;
      const state: TradeMark["state"] = o.status === "filled" || o.status === "partial" ? "filled" : o.status === "rejected" ? "failed" : "pending";
      const ack = o.ackAt && o.sentAt ? ` · accepted in ${o.ackAt - o.sentAt}ms` : "";
      const fill = o.filledAt && o.sentAt ? ` · filled in ${o.filledAt - o.sentAt}ms` : "";
      const at = o.avgPrice ? ` at $${o.avgPrice.toFixed(1)}` : "";
      return { id: o.id, t: Math.max(0, Math.min(1, (sent - venue.startedAt) / span)), side: o.side, price: o.avgPrice, state, label: `${o.side === "buy" ? "Buy" : "Sell"} to ${o.kind}${at}${ack}${fill}${o.error ? ` · ${o.error}` : ""}` };
    });
  }, [venue]);
  const segmentMarks = useMemo<SegmentMark[]>(() => {
    // Before placing, the plan the trader will compile from this line: what you see is what trades.
    if (phase === "drawn" && shape) {
      return shape.legs.map((leg, i) => ({
        id: `plan-${i}`,
        dir: leg.dir,
        from: i === 0 ? 0 : leg.from / (SAMPLES - 1),
        to: shape.legs[i + 1] ? shape.legs[i + 1].from / (SAMPLES - 1) : (view.at(-1)?.t ?? 1),
        skipped: false,
        editable: false,
      }));
    }
    if (!venue?.segments?.length || !venue.seconds) return [];
    const span = venue.seconds * 1000;
    return venue.segments.map((seg) => {
      const from = (seg.startAt - venue.startedAt) / span;
      return { id: seg.id, dir: seg.dir, from, to: (seg.endAt - venue.startedAt) / span, skipped: seg.skipped, editable: venue.status === "running" && from > editableFrom };
    });
  }, [venue, editableFrom, phase, shape, view]);
  /* Each trade's stretch of the ribbon, coloured by what it made. */
  const tradeBands = useMemo(() => {
    if (!chart || !venue?.seconds) return [];
    const span = venue.seconds * 1000;
    const now = run.length / runBars;
    return chart.trades.map((t) => ({ id: t.id, dir: t.dir, from: (t.from - venue.startedAt) / span, to: t.to === null ? now : (t.to - venue.startedAt) / span, pnl: t.pnl }));
  }, [chart, venue, run.length, runBars]);
  const onSkip = (id: string, skipped: boolean) => {
    if (!venueId) return;
    void skipSegment(venueId, id, skipped).then((r) => setVenueProblem("error" in r ? r.error : null));
  };

  const phone = usePhone();

  /*
    Rounds and the tools drawer, floating over the top left of the chart.

    The chart has a line down the middle marking now: everything left of it is
    price that has already happened, which you read and never touch, and
    everything right of it is where the drawing goes. So the left is the one
    part of this screen with room to spare, and anything that has to be on
    screen without being in the way belongs there rather than taking a row of
    its own above the chart.
  */
  const shelf = phone ? (
    /* Bottom left, under the zoom column and matching it: same circle, same
       size, same card behind it. Two big ones below four small ones read as
       a different thing bolted on. */
    <div className="pointer-events-none absolute bottom-2 left-2 z-10 flex w-13 flex-col items-center gap-1.5 [&>*]:pointer-events-auto">
      <Button
        aria-label={`Rounds, ${sketches.length}`}
        className="relative size-10 shrink-0 rounded-full border bg-card/85 backdrop-blur-sm"
        onClick={() => setListOpen(true)}
        size="icon"
        variant="outline"
      >
        <HistoryIcon />
        {sketches.length > 0 ? (
          <span className="figures -top-1 -right-1 absolute flex size-4 items-center justify-center rounded-full border bg-card text-[10px] text-muted-foreground">
            {sketches.length}
          </span>
        ) : null}
      </Button>
      <PhoneTools
        canUndo={pts.length > 1}
        drawing={phase !== "running" && phase !== "settled"}
        exits={exits}
        onClear={onClear}
        onExits={setExits}
        onPreset={onPreset}
        onUndo={onUndo}
        stake={stake}
      />
    </div>
  ) : null;

  /* A round or position the account already holds, wherever it runs. It has to close before another opens. */
  const blockingRound = everyRound.find((r) => r.status !== "done" && r.id !== venueId);
  const needsRecovery = !!me.address && hasTrader && !venueId && ((profile.balance?.positions ?? 0) > 0 || !!blockingRound);
  const recoverPosition = async () => {
    if (!me.address || placementLock.current) return;
    placementLock.current = true;
    setPlacing(true);
    setVenueProblem(null);
    try {
      const result = blockingRound ? await closeRound(blockingRound.id) : await closeExistingPosition(me.address, market.symbol);
      if (!result) throw new Error("Close request failed. Your position may still be open; retry.");
      setVenueId(result.id);
      setPhase(result.status === "done" ? "settled" : "running");
      if (result.status === "done") setListOpen(true);
      setVenueProblem(result.problem);
      window.dispatchEvent(new Event("skech-balance"));
    } catch (error) {
      setVenueProblem((error as Error).message);
    } finally {
      placementLock.current = false;
      setPlacing(false);
    }
  };

  /*
    Size, boost and the button, plus the tools drawer on a phone.

    Defined once and placed twice over, because where it belongs is not the
    same on both. On a desk it sits in the chart's own header, beside the
    market. On a phone that header was two cramped rows and the button that
    spends the money ended up at the top of the screen, furthest from a thumb,
    so it goes to the bottom bar instead.
  */
  /*
    Boost, the button, size.

    Three things on the row that spends money, and nothing else: on a phone
    every other control has somewhere quieter to live, and a row of five
    asks somebody to read five things before pressing one.
  */
  const onDrawMore = () => {
    if (extending) return setExtending(false);
    setExtending(true);
    extendRound();
  };
  const onCloseNow = () => {
    if (!venueId || closeRequested) return;
    setCloseRequested(true);
    void closeRound(venueId)
      .then((result) => setVenueProblem(result ? result.problem : "Close request failed. Retry; the position may still be open."))
      .finally(() => setCloseRequested(false));
  };
  /* Why the button cannot trade right now, first reason first; nothing when it can. */
  const unavailableReason = placing
    ? "Opening trade…"
    : !me.address
      ? "Sign in to trade"
      : !hasTrader
        ? "Trading unavailable"
        : !stream?.connected || !stream.latest
          ? "Waiting for live prices…"
          : (profile.balance?.positions ?? 0) > 0 || history.some((r) => r.status !== "done" && r.id !== venueId)
            ? "Finish your open trade"
            : undefined;

  /* The running round's figures for the bar: the chart's valuation on testnet, the venue's otherwise. */
  const venueOpen = venue?.trades?.find((t) => t.status === "open");
  const liveFigures = venue
    ? {
        net,
        open: chartBased
          ? openChart
            ? { dir: openChart.dir, pnl: openChart.pnl }
            : null
          : venueOpen
            ? { dir: venueOpen.dir, pnl: venue.unrealised }
            : null,
        trades: chart?.trades.length ?? venue.trades?.filter((t) => t.status !== "failed").length ?? 0,
      }
    : undefined;

  const controls = (
    <div className="flex w-full items-center gap-1.5 sm:w-auto sm:gap-2">
      <PlaceTicket
        recovery={needsRecovery ? { onClose: () => void recoverPosition(), pending: placing } : undefined}
        exits={exits}
        leverage={leverage}
        market={market}
        closing={closeRequested || (venue?.status === "closing" && !venue.problem)}
        drawingMore={extending}
        enable={needsKey && needsKey === me.address ? { onEnable: () => void enableTrading(), pending: enabling } : undefined}
        onDrawMore={venueId ? onDrawMore : undefined}
        onCloseNow={onCloseNow}
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
        unavailableReason={unavailableReason}
        shape={shape}
        stake={stake}
      />
    </div>
  );

  return (
    /*
      Edge to edge on a phone, a card on a desk.

      The margin, the border and the rounded corners are how a panel sits on a
      desk among other panels. On a phone there is nothing to sit among: it is
      the whole screen, and the inset only takes eight pixels off each side of
      the chart and puts a hairline where the screen edge already is. So the
      phone gets the plain three-part shape a phone app has, bar, content,
      footer, and the desk keeps its card.
    */
    <section
      aria-label="Draw"
      className="flex min-h-[24rem] flex-1 flex-col overflow-hidden border-0 bg-background sm:m-2 sm:rounded-2xl sm:border"
    >
      {/* Market on the left; exits, size, boost and the button hard right, on
          the chart's own header. Not drawn at all on a phone: the market is in
          the app bar and the controls are in the footer, so this was an empty
          bordered strip putting a gap between the bar and the chart. */}
      <div className="hidden flex-wrap items-center gap-1.5 border-b px-2 py-2 sm:flex sm:gap-2 sm:px-3">
        {/* The day comes from the live venue; the descriptor’s own
            figures are about a price that is no longer on the screen. */}
        <MarketHeader
          /* In the app bar on a phone, so this one is the desk's. */
          className="max-sm:hidden sm:w-auto"
          market={
            stream?.stats
              ? { ...market, price, change: (price * stream.stats.changePct) / 100, changePct: stream.stats.changePct, high24h: stream.stats.high, low24h: stream.stats.low, volume24h: stream.stats.volume }
              : { ...market, price, change: price - prev, changePct: ((price - prev) / prev) * 100 }
          }
        />
        {phone ? null : <div className="ml-auto">{controls}</div>}
      </div>
      {/* The chart runs to the edges on a phone: there is no panel beside it
          for the gutter to separate it from. */}
      {stream?.network ? <div className="px-4 pt-2 text-xs text-muted-foreground">{stream.network === "mainnet" ? NETWORK === "testnet" ? `Lighter ${market.symbol} · Mainnet chart · Your trades fill on testnet, whose price and spread differ from this chart` : `Lighter ${market.symbol} · Mainnet trade candles` : "Testnet · Mark-price candles"}<span className="ml-2">{stream.connected ? "Live venue prices" : "Waiting for venue prices…"}</span></div> : null}
      <div className="flex min-h-0 flex-1 gap-2 sm:px-2 sm:pt-2">
        {/* Always present. What it holds changes with the phase; the chart
            settings are in it whatever is happening to the money. */}
        <div className="hidden sm:block">
          <DrawTools canUndo={pts.length > 1} drawing={phase !== "running" && phase !== "settled"} onClear={onClear} onPreset={onPreset} onUndo={onUndo} />
        </div>
        <div className="relative min-w-0 flex-1">
        {/*
          The market, over the top left of the chart, on a phone.

          A nav bar is for the app: the logo and the way in. A price belongs
          with the picture of it, and over the chart it costs no layout at all
          where a row of its own cost a band of chrome. Left aligned above
          the column of chart controls.
        */}
        {phone ? (
          <div className="absolute top-4 left-3 z-10">
            <MarketHeader market={{ ...market, price }} />
          </div>
        ) : null}
        {shelf}
        {stream && !stream.connected ? (
          <div className="pointer-events-none absolute top-3 left-3 z-10 rounded-md border bg-background/95 px-2.5 py-1 text-xs text-foreground max-sm:top-auto max-sm:right-3 max-sm:bottom-8 max-sm:left-auto" role="status">
            Waiting for live market data…
          </div>
        ) : null}
        {price > 0 && feed.length > 0 ? <SketchCanvas
          band={band}
          feed={feed}
          /*
            A fixed window while drawing: the round grows as you draw, and fitting it shrank the
            bars under the hand. Only `drawn` fits the whole plan.
          */
          horizonBars={phase === "drawn" ? runBars : viewBars}
          editableFrom={editableFrom}
          onDown={onDown}
          onGrab={onGrab}
          onMove={onMove}
          onRemove={onRemove}
          onUp={onUp}
          phase={phase}
          pnl={net}
          marks={marks}
          tradeBands={tradeBands}
          segments={segmentMarks}
          onSkip={venueId && phase === "running" ? onSkip : undefined}
          price={price}
          pts={view}
          run={run}
          runBars={runBars}
          shape={shape}
          ghost={ghost}
          ribbon={ribbon}
        /> : <div role="status" className="flex h-full items-center justify-center text-sm text-muted-foreground">Waiting for live candles…</div>}
        </div>
      </div>
      {phase === "running" && venue ? <div role="status" aria-live="polite" className="border-t px-4 py-2 text-sm text-muted-foreground">{roundStatus(venue, openedIn)}</div> : null}
      {/* The bar takes its row; the plot above it is never covered. */}
      <div className="flex flex-col gap-2 border-t px-3 py-3">
        <SketchBar
          market={market}
          onOpenList={() => setListOpen(true)}
          phone={phone}
          onVenue={venue !== null}
          venueAccount={notMine ? venue.accountIndex : null}
          venueProblem={venueProblem ?? venue?.problem}
          openCount={shown.length}
          phase={phase}
          quote={quote}
          runCount={run.length}
          live={liveFigures}
          runBars={phase === "drawn" ? barsFor(view, runBars) : runBars}
          shape={shape}
          sketches={shown}
        />
        {/* Within reach on a phone, and the only row that has to be. */}
        {phone ? controls : null}
      </div>
      {needsRecovery ? <p className="border-t px-4 py-3 text-sm text-muted-foreground">You have an open position on Lighter. Use {phone ? "Close position" : "Close open position"} above to close it before starting another trade.</p> : null}
      {elsewhere && elsewhereMarket && !venueId ? (
        <p className="px-4 py-2 text-sm text-muted-foreground">
          Your {elsewhereMarket.name} trade is still running. One trade at a time: <Link className="font-medium text-foreground underline underline-offset-4" href={`/app/${elsewhereMarket.address}`}>open it</Link>, or close it here.
        </p>
      ) : null}
      {venueProblem ? <p role="alert" className="px-4 py-2 text-sm text-down">{venueProblem}</p> : null}
      <RoundsSheet
        social={social}
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

/** One line on what the venue is doing with this round right now. */
function roundStatus(round: VenueRound, openedIn: number | null): string {
  const orders = round.orders?.filter((o) => o.kind !== undefined) ?? [];
  const pending = orders.findLast((o) => o.status === "sending" || o.status === "acked" || o.status === "uncertain");
  const opened = openedIn !== null ? ` · opened in ${openedIn}ms` : "";
  if (round.status === "closing") return `Closing on Lighter…${opened}`;
  if (pending) {
    const what = `${pending.side === "buy" ? "Buy" : "Sell"} to ${pending.kind}`;
    if (pending.status === "sending") return `${what} · sending…${opened}`;
    if (pending.status === "uncertain") return `${what} · no answer yet, checking the venue…`;
    return `${what} · accepted in ${(pending.ackAt ?? 0) - (pending.sentAt ?? 0)}ms · awaiting fill${opened}`;
  }
  const open = round.trades?.find((t) => t.status === "open" || t.status === "opening");
  const closed = round.trades?.filter((t) => t.status === "closed").length ?? 0;
  const done = closed ? ` · ${closed} closed` : "";
  if (open) return `${open.dir > 0 ? "Long" : "Short"} open${open.entry ? ` at $${open.entry.toFixed(1)}` : ""}${done}${opened}`;
  return `Flat${done}${opened}`;
}
