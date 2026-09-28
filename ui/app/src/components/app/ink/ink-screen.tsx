"use client";

import { CheckIcon, ChevronDownIcon, ChevronRightIcon, ShareIcon, SlidersHorizontalIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { DIFFICULTY, difficulty, DOT_BETS, features, type Field, type Library, readLibrary, RULES, setDifficulty, START_BALANCE, stepFor } from "@skech/core/dots";
import { areaCostOf, cost, decided, isArea, liveInkTotals, judge, open, openOn, INK_EDGE_CELLS, drawingLayout, INK_CELL, placeInk, refund, type Stroke, won } from "@skech/core/ink";
import { roundedTerms as areaTerms } from "@skech/core/odds";

import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Popover, PopoverClose, PopoverPopup, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { setDark, useDark } from "@/components/app/theme-toggle";

import { Sheet, SheetDescription, SheetHeader, SheetPanel, SheetPopup, SheetTitle } from "@/components/ui/sheet";
import { useCoinbase } from "@/lib/coinbase";
import { buzz, cents, practice, record, setPractice, sound, usePractice } from "@/lib/practice";
import { cn } from "@/lib/utils";
import { fmtMultiple, type Game, type Preview, Stage } from "./stage";
import { TokenAvatar } from "@/components/app/market-header";
import { DepositButton, InkControls } from "./ink-controls";
import feedback from "./drawing-feedback.module.css";
import { CrispNumber } from "./crisp-number";

/**
 * skech. Draw ahead of the Bitcoin price; wherever it runs through your ink
 * pays.
 *
 * A line is the union of its pen-covered area, priced in full-dot units.
 * It is quoted while drawing and committed on release. Only touched ink pays.
 * The rules are `@skech/core/dots`, the same
 * code the server will run once there is money in it. This screen keeps the
 * practice money, prices the map, opens each drawing on its second, and
 * judges every second's trades as they arrive.
 */

/** In development, anything that holds the page up for more than 50 ms says so. */
const slow = (what: string, since: number, detail: string) => {
  const ms = performance.now() - since;
  if (process.env.NODE_ENV !== "production" && ms > 50) console.warn(`[ink] slow ${what}: ${Math.round(ms)} ms (${detail})`);
};

/** A drawing opens once its second has closed and this much longer, for trades that arrive late. */
const OPEN_AFTER_MS = 350;
/** By then a drawing whose second has no map yet (the pen changed, or the worker is slow) is priced on the paths, here. */
const OPEN_BY_MS = 900;
/** A second's dots are missed only this long after it ends, for the same reason. */
const CLOSE_AFTER_MS = 600;
const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const signed = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${money(Math.abs(n))}`;

/** A price with its cents quieter than its dollars. */
const Price = ({ value }: { value: number }) => {
  const [whole, part] = money(value).split(".");
  return <><CrispNumber value={whole} /><span className={feedback.cents}>.{part}</span></>;
};

/** One setting on a switch, in a grouped list. */
function ToggleRow({ title, detail, checked, onChange }: { title: string; detail: string; checked: boolean; onChange: (next: boolean) => void }) {
  return (
    <label className="flex min-h-[60px] cursor-pointer items-center gap-3 px-4">
      <span className="flex grow flex-col"><span className="text-[17px]">{title}</span><span className="text-[13px] text-muted-foreground">{detail}</span></span>
      <Switch checked={checked} className="[--thumb-size:27px] data-checked:bg-success sm:[--thumb-size:27px]" onCheckedChange={onChange} />
    </label>
  );
}

const navRow = "flex min-h-[52px] w-full items-center gap-3 px-4 text-left text-[17px] transition-colors hover:bg-accent";

export function InkScreen() {
  const feed = useCoinbase("BTC-USD");
  const state = usePractice();
  /* The paths every chance is measured on: a file of their own, fetched once. Nothing is priced until it is in. */
  const [lib, setLib] = useState<Library | null>(null);
  /* The map is measured in a worker of its own, on its own copy of the paths: see `field.worker.ts`. */
  const worker = useRef<Worker | null>(null);
  const requestId = useRef(0);
  useEffect(() => {
    let live = true;
    const w = new Worker(new URL("./field.worker.ts", import.meta.url), { type: "module" });
    worker.current = w;
    void fetch("/dots-lib.bin")
      .then((r) => r.arrayBuffer())
      .then((b) => {
        if (!live) return;
        w.postMessage({ kind: "lib", bytes: b.slice(0) });
        setLib(readLibrary(new Uint8Array(b)));
      })
      .catch(() => undefined);
    return () => {
      live = false;
      w.terminate();
      worker.current = null;
    };
  }, []);

  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const changed = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);
  const expand = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch { /* Embedded browsers may not expose fullscreen. The layout still fills its viewport. */ }
  };

  const [preview, setPreview] = useState<Preview | null>(null);
  const [help, setHelp] = useState(false);
  const [returnedInk, setReturnedInk] = useState<{ id: string; amount: number } | null>(null);
  useEffect(() => {
    if (!returnedInk) return;
    const timer = setTimeout(() => setReturnedInk(null), 3200);
    return () => clearTimeout(timer);
  }, [returnedInk]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const dark = useDark();
  /** How hard the game is here: what the house set on this browser, or the game's own. */
  const level = state.houseDifficulty ?? DIFFICULTY;
  /* The house's controls show in development, or with ?house in the address. */
  const [house] = useState(() => typeof window !== "undefined" && (process.env.NODE_ENV !== "production" || new URLSearchParams(window.location.search).has("house")));
  const [live, setLive] = useState(0);
  const [result, setResult] = useState<{ key: string; won: number; cost: number; hits: number; points: number; voided: boolean } | null>(null);
  useEffect(() => {
    if (!result) return;
    const t = setTimeout(() => setResult(null), 5000);
    return () => clearTimeout(t);
  }, [result]);
  const [fresh, setFresh] = useState(false);
  /* The balance shows green for a moment when a hit pays into it. */
  const [gained, setGained] = useState(0);
  useEffect(() => {
    if (!gained) return;
    const t = setTimeout(() => setGained(0), 1200);
    return () => clearTimeout(t);
  }, [gained]);
  const game = useRef<Game>({ bars: [], ticks: [], skew: 0, field: null, step: 1, marketStep: 1, viewport: { width: 1280, height: 800 }, displayPrice: 0, perDot: state.perDot, pen: state.brush, cell: INK_CELL, bets: [], quote: null, fx: [], hint: !state.taught, dark: false });

  const onViewport = useCallback((size: { width: number; height: number }) => { game.current.viewport = size; }, []);
  const settledTotals = useRef({ committed: 0, returned: 0 });
  const [totals, setTotals] = useState(() => liveInkTotals([]));
  const updateTotals = useCallback(() => {
    const next = liveInkTotals(game.current.bets, settledTotals.current);
    setTotals(previous => previous.committed === next.committed && previous.returned === next.returned && previous.settledCost === next.settledCost && previous.drawings === next.drawings ? previous : next);
  }, []);

  // For tests and debugging in development: the live game, and the engine and paths it prices on, from the console.
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") Object.assign(window, { __dots: game.current, __engine: { lib, open, judge, features }, __practice: { get: practice, set: setPractice }, __rules: RULES });
  }, [lib]);

  useEffect(() => {
    const g = game.current;
    g.perDot = state.perDot;
    // How hard the game is: every drawing priced from now on, and the map, use it.
    setDifficulty(level);
    if (g.field && g.field.rtp !== difficulty(level).rtp) g.field = null;
    g.pen = state.brush;
    g.cell = INK_CELL;
    g.hint = !state.taught;
  }, [state.perDot, state.brush, state.taught, level]);

  /*
    Every quarter second: whether the page is dark, whether the prices are
    fresh, and the field, priced for a drawing placed now. The dot size
    follows the market, but only while nothing of yours is on it.
  */
  const connected = feed.connected && lib !== null;
  useEffect(() => {
    /* One map asked for at a time; a new one once a second, or at once when the pen or the step changes. */
    let asked = "";
    let busy = 0;
    let pendingId = 0;
    const w = worker.current;
    const onMap = (e: MessageEvent<{ id: number; field: Field }>) => {
      if (e.data.id !== pendingId) return;
      busy = 0;
      const g = game.current;
      if (Date.now() + g.skew - e.data.field.openAt > 2500) { asked = ""; return; }
      // Reject results priced for an outdated scale or difficulty.
      if (Math.abs(e.data.field.step - g.step * g.cell) > 1e-9 || e.data.field.rtp !== difficulty(level).rtp || e.data.field.edgeCells !== INK_EDGE_CELLS) return;
      g.field = e.data.field;
    };
    w?.addEventListener("message", onMap);
    const tick = () => {
      const g = game.current;
      g.dark = document.documentElement.classList.contains("dark");
      const latest = g.bars.at(-1);
      const nowMs = Date.now() + g.skew;
      const last = g.ticks.at(-1)?.t ?? latest?.t ?? 0;
      const ok = connected && !!latest && nowMs - last < 5000 && g.bars.length > 60;
      setFresh(ok);
      if (!ok || !lib) {
        g.field = null;
        return;
      }
      /*
        The map is of the last second that is over, with the margin for late
        trades: the second the drawings due now open on, so they are priced
        straight off it. What is being drawn is quoted on it too, a second
        behind at most.
      */
      const at = Math.floor((nowMs - OPEN_AFTER_MS) / 1000) * 1000;
      const f = features(g.bars, at);
      if (!f) return;
      /*
        The price step follows the market, once it has moved well off the
        old one so it does not flicker. Drawings already placed keep their
        own prices, so it can change under them. Held while they were live,
        a market that got busy was mapped in hundreds of tiny steps, and the
        page stalled drawing them.
      */
      const want = stepFor(f.sigma, f.price);
      if (!g.drawing) {
        if (g.field === null || Math.abs(Math.log(want / g.marketStep)) > Math.log(1.6)) g.marketStep = want;
        g.step = drawingLayout(g.viewport.width, g.viewport.height, g.marketStep).step;
      }
      // Use the same fine price slices for every pen.
      const size = g.step * g.cell;
      const key = `${at}:${size}:${level}`;
      // An answer that never came (a worker that died, say) stops holding the next one up after two seconds.
      if (busy && performance.now() - busy > 2000) { busy = 0; asked = ""; }
      if (key !== asked && !busy && w) {
        asked = key;
        busy = performance.now();
        pendingId = ++requestId.current;
        w.postMessage({ kind: "field", id: pendingId, f, at, step: size, cell: g.cell, difficulty: level });
      }
    };
    tick();
    // Often, so a second's map is asked for soon after the second is over: the tick itself is a fraction of a millisecond.
    const timer = setInterval(tick, 100);
    // What the stroke being drawn would cost and pay: the terms of the game, read off the map, cheap enough for every move of the pen.
    game.current.quote = (st: Stroke) => {
      const g = game.current;
      if (!g.field) return null;
      const t0 = performance.now();
      const l = areaTerms(g.field, Date.now() + g.skew, g.drawing?.step ?? g.step, g.drawing?.perDot ?? g.perDot).line(st);
      slow("quote", t0, `points ${l.points.length} pts ${st.pts.length} step ${g.step}`);
      return { multipleLow: l.multipleLow, multipleHigh: l.multipleHigh, cost: l.cost, low: l.low, high: l.high, units: l.units, inPlay: l.inPlay, out: l.out };
    };
    return () => {
      clearInterval(timer);
      w?.removeEventListener("message", onMap);
    };
  }, [connected, lib, level]);

  /*
    Every trade: open what is due, judge what is live. Drawings placed
    before a reload come back once there are prices to judge them on; dots
    older than those prices cannot be judged either way, and come back.
  */
  const lines = useRef(new Map<string, { at: number; open: number; won: number; cost: number; hits: number; points: number; best: number }>());
  /** Drawings still under the pen: what has been bet of each so far, so the next piece bets only new ink. */
  const drawing = useRef(new Map<string, { prev: Stroke | null; area: number; charged: number; at: number; pieces: number }>());
  /** What each drawing's hits came to, unrounded, and what has been credited: a drawing rounds its payout once, not once per piece. */
  const payouts = useRef(new Map<string, { raw: number; credited: number }>());
  const tally = (line: string, at: number) => {
    let t = lines.current.get(line);
    if (!t) lines.current.set(line, (t = { at, open: 0, won: 0, cost: 0, hits: 0, points: 0, best: 0 }));
    return t;
  };
  /** A line is over once the pen has lifted and every point of it is decided: say what it came to, once. */
  const closeLine = (line: string) => {
    const t = lines.current.get(line);
    if (!t || t.open > 0 || drawing.current.has(line)) return;
    lines.current.delete(line);
    const paidOut = payouts.current.get(line);
    payouts.current.delete(line);
    if (paidOut) t.won = paidOut.credited;
    if (!t.points) return setResult({ key: line, won: 0, cost: 0, hits: 0, points: 0, voided: true });
    setResult({ key: line, won: cents(t.won), cost: cents(t.cost), hits: t.hits, points: t.points, voided: false });
    record({ id: line, at: t.at, cost: cents(t.cost), won: cents(t.won), hits: t.hits, dots: t.points, best: t.best });
  };
  /*
    One tab plays at a time. Two tabs of the game each brought back the
    drawings in play from storage, and each paid their hits: every win in
    play was paid twice. The tab holding the lock restores, judges and
    places; another says so, and can take over.
  */
  // Where the browser cannot lock, this tab plays.
  const [owner, setOwner] = useState<boolean | null>(() => (typeof navigator !== "undefined" && !navigator.locks ? true : null));
  const takeOver = useRef<(() => void) | null>(null);
  const restored = useRef(false);
  useEffect(() => {
    const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
    if (!locks) return;
    let done = false;
    let release: (() => void) | null = null;
    /*
      Waiting for the lock, not asking only if it is free: a page that is
      remounted (a reload in development, React's double start) asks again
      while its first copy still holds it. Not given it within a moment, it
      says another tab has it; given it later, when that tab closes, it plays.
    */
    let blocked: ReturnType<typeof setTimeout> | undefined;
    const ask = (steal: boolean) => {
      clearTimeout(blocked);
      blocked = setTimeout(() => !done && setOwner((o) => (o ? o : false)), 800);
      return locks
        .request("skech:ink", steal ? { steal: true } : {}, (lock) => {
          clearTimeout(blocked);
          if (done || !lock) return;
          // A new holder starts from what is in storage, as a fresh page does.
          restored.current = false;
          game.current.bets = [];
          setOwner(true);
          return new Promise<void>((r) => (release = r));
        })
        .catch(() => {
          // Taken by another tab: stop, and leave its drawings to it.
          if (done) return;
          game.current.bets = [];
          setOwner(false);
        });
    };
    void ask(false);
    takeOver.current = () => void ask(true);
    return () => {
      done = true;
      clearTimeout(blocked);
      release?.();
    };
  }, []);
  const { bars, ticks, skew, version } = feed;
  useEffect(() => {
    const g = game.current;
    g.bars = bars;
    g.ticks = ticks;
    g.skew = skew;
    g.displayPrice = ticks.at(-1)?.p ?? bars.at(-1)?.c ?? 0;
    const latest = bars.at(-1);
    if (!latest || !lib || !owner) return;
    const nowMs = Date.now() + skew;
    let credit = 0;
    if (!restored.current && bars.length > 300) {
      restored.current = true;
      const firstBar = bars[0].t + 5000;
      for (const bet of practice().open) {
        if (bet.openAt >= firstBar) {
          g.bets.push(bet);
          if (!decided(bet)) tally(bet.group ?? bet.id, bet.placedAt).open++;
          continue;
        }
        // Too old to judge: what is still riding on it comes back. Ink already hit was paid when it was.
        credit += bet.status === "opening" ? cost(bet) : bet.perUnit * bet.cells.filter((s) => s.status === "live").reduce((a, s) => a + s.area, 0);
      }
    }
    let changed = false;
    for (let i = 0; i < g.bets.length; i++) {
      let bet = g.bets[i];
      if (bet.status === "opening" && nowMs >= bet.openAt + OPEN_AFTER_MS) {
        // Off its second's map when that is in; on the paths, here, if it is not by the time it has to be.
        const quick = g.field ? openOn(bet, g.field) : null;
        if (!quick && nowMs < bet.openAt + OPEN_BY_MS) {
          g.bets[i] = bet;
          continue;
        }
        bet = quick ?? open(bet, lib, bars);
        const returned = refund(bet);
        credit += returned;
        if (returned > 0) setReturnedInk({ id: bet.id, amount: returned });
        if (bet.status === "void") g.fx.push({ kind: "placed", t: bet.openAt, price: latest.c, born: performance.now() });
        changed = true;
      }
      if (bet.status === "live") {
        const from = Math.min(...bet.cells.filter((d) => d.status === "live").map((d) => d.t));
        for (let k = 0; k < bars.length; k++) {
          const bar = bars[k];
          if (bar.t < from) continue;
          const before = bet;
          // From where the second before closed: a jump across the ink crosses it, as the line on the chart does.
          const prev = k > 0 && bars[k - 1].t === bar.t - 1000 ? bars[k - 1].c : undefined;
          bet = judge(bet, bar, bar.t + 1000 + CLOSE_AFTER_MS <= nowMs, prev);
          if (bet === before) continue;
          changed = true;
          // One burst a second, however many cells of ink the price crossed in it, with what they paid together.
          const fresh2 = bet.cells.filter((d, k) => d.status === "hit" && before.cells[k].status !== "hit");
          if (fresh2.length) {
            const line = bet.group ?? bet.id;
            const acc = payouts.current.get(line) ?? { raw: 0, credited: 0 };
            payouts.current.set(line, acc);
            acc.raw += won(bet) - won(before);
            // Credit whole cents of the drawing's running total; the fraction waits for its next hit.
            const due = Math.max(0, Math.floor(acc.raw * 100 + 1e-8) / 100 - acc.credited);
            acc.credited = cents(acc.credited + due);
            credit += due;
            // Where it landed, the drawing's running result: what its hits
            // have paid so far less what it cost. A hit on a drawing that is
            // still behind reads as a loss, not as the payout.
            const spent = g.bets.reduce((n, b, j) => (b.group ?? b.id) === line ? n + cost(j === i ? bet : b) - refund(j === i ? bet : b) : n, 0);
            const net = cents(acc.raw - spent);
            const best = Math.max(...fresh2.map((d) => d.multiple * (isArea(bet.model) ? d.area : 1)));
            const lo = Math.min(...fresh2.map((d) => d.lo));
            const hi = Math.max(...fresh2.map((d) => d.hi));
            // One number per drawing: a new hit replaces the last one's.
            g.fx = g.fx.map((e) => e.line === line ? { ...e, text: undefined } : e);
            g.fx.push({ kind: "hit", t: fresh2[0].t + 500, price: Math.min(hi, Math.max(lo, bar.c)), born: performance.now(), text: signed(net), loss: net < 0, line, big: best >= 10 });
            if (practice().sound) sound.hit(best);
            buzz(best >= 10 ? 40 : 12);
          }
          if (bet.status !== "live") break;
        }
      }
      if (decided(bet) && !decided(g.bets[i])) {
        settledTotals.current.committed += cost(bet) - refund(bet);
        settledTotals.current.returned += won(bet);
        const line = bet.group ?? bet.id;
        const t = tally(line, bet.placedAt);
        t.open--;
        if (bet.status === "done") {
          const hitCells = bet.cells.filter((d) => d.status === "hit");
          t.won += won(bet);
          t.cost += cost(bet) - refund(bet);
          t.hits += isArea(bet.model) ? hitCells.reduce((n, c) => n + c.area, 0) : hitCells.length;
          t.points += isArea(bet.model) ? bet.cells.reduce((n, c) => n + c.area, 0) : bet.cells.length;
          t.best = Math.max(t.best, ...hitCells.map((d) => d.multiple * (isArea(bet.model) ? d.area : 1)));
        }
        if (t.open <= 0) closeLine(line);
      }
      g.bets[i] = bet;
    }
    if (credit) setPractice((s) => ({ balance: cents(s.balance + credit) }));
    if (credit > 0) setGained(performance.now());
    if (changed || credit) setPractice({ open: g.bets.filter((b) => !decided(b)) });
    setLive(new Set(g.bets.filter((b) => !decided(b)).map((b) => b.group ?? b.id)).size);
    // Keep finished drawings only as long as their dots are still fading.
    g.bets = g.bets.filter((b) => !decided(b) || b.cells.some((d) => d.t + 3000 > nowMs));
    updateTotals();
  }, [bars, ticks, skew, version, lib, owner, updateTotals]);

  /*
    Ink is bet as it is drawn: every few moments while the pen is down, the
    ink added since the last piece opens on the next second, priced on what
    is known then. A long stroke is not priced on where the market was when
    the pen lifted, and ink near now is not lost to the wait. The drawing's
    stake rounds up once over its pieces (each piece takes the growth of the
    rounded total), so cost does not depend on how often the pen is read.
  */
  const onPlace = useCallback(
    (stroke: Stroke, line: string, done: boolean): string | null => {
      const g = game.current;
      if (!owner) return "Playing in another tab";
      if (!fresh || !g.field) return "Waiting for live prices";
      const d = drawing.current.get(line) ?? { prev: null, area: 0, charged: 0, at: 0, pieces: 0 };
      const finish = () => {
        if (!done) return;
        drawing.current.delete(line);
        closeLine(line);
      };
      const t0 = performance.now();
      if (!done && t0 - d.at < 150) return null;
      d.at = t0;
      const settings = g.drawing ?? { step: g.step, perDot: practice().perDot };
      const placedAt = Date.now() + g.skew;
      const snap: Stroke = { ...stroke, pts: stroke.pts.slice() };
      const bet = placeInk(snap, d.prev, settings.perDot, settings.step, placedAt, `${line}:${d.pieces}`, line, INK_EDGE_CELLS);
      if (!bet) {
        finish();
        return done && !d.pieces ? "Draw ahead of the wait line" : null;
      }
      const area = d.area + bet.drawn.reduce((n, c) => n + c.area, 0);
      const charge = cents(areaCostOf(settings.perDot, area) - d.charged);
      if (charge > practice().balance) {
        finish();
        return "Not enough practice money";
      }
      bet.charged = charge;
      if (!drawing.current.has(line)) drawing.current.set(line, d);
      d.prev = snap;
      d.area = area;
      d.charged = cents(d.charged + charge);
      d.pieces++;
      if (!g.bets.some(b => !decided(b))) settledTotals.current = { committed: 0, returned: 0 };
      tally(line, bet.placedAt).open++;
      g.bets.push(bet);
      updateTotals();
      if (process.env.NODE_ENV !== "production") (window as unknown as { __lastBet?: unknown }).__lastBet = bet;
      setPractice(st => ({ balance: cents(st.balance - charge), taught: true, open: g.bets.filter(b => !decided(b)) }));
      setLive(new Set(g.bets.filter(b => !decided(b)).map(b => b.group ?? b.id)).size);
      if (d.pieces === 1) {
        if (practice().sound) { sound.wake(); sound.place(); }
        buzz(8);
      }
      if (done) {
        const tip = stroke.pts.at(-1)!;
        g.fx.push({ kind: "placed", t: stroke.t0 + tip.t, price: stroke.p0 + tip.p, born: performance.now() });
      }
      finish();
      return null;
    },
    [fresh, owner, updateTotals],
  );


  // For tests in development: place a line from the console, as the pen does.
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") (window as unknown as { __place?: typeof onPlace }).__place = onPlace;
  }, [onPlace]);

  /* A soft tick as the ink grows, so drawing is heard as well as seen. */
  const painted = useRef(0);
  const onPreview = useCallback((p: Preview | null) => {
    setPreview(p);
    const n = p?.inPlay.length ?? 0;
    if (!p?.keyboard && n > painted.current && practice().sound) {
      sound.wake();
      sound.paint();
    }
    painted.current = n;
  }, []);

  const broke = state.balance < DOT_BETS[0] && live === 0;
  const price = feed.ticks.at(-1)?.p ?? feed.bars.at(-1)?.c ?? 0;
  const [listOpen, setListOpen] = useState(false);
  // The same Skech controls: nib size and the cost of a full dot.
  const controls = (
    <InkControls
      amount={state.perDot}
      className="w-full sm:w-auto"
      onAmount={(n) => setPractice({ perDot: n })}
      onPen={(id) => setPractice({ brush: id })}
      pen={state.brush}
    />
  );

  /* A round's result, to send on: the phone's own share sheet, or the clipboard. */
  const share = async (net: number) => {
    const text = `I drew ahead of the Bitcoin price on skech: ${signed(net)}`;
    try {
      if (navigator.share) await navigator.share({ text, url: window.location.origin });
      else await navigator.clipboard.writeText(`${text} ${window.location.origin}`);
    } catch { /* Dismissed, or not allowed here. */ }
  };

  const latestResult = state.history[0];
  const showingBatch = totals.drawings > 0 || totals.committed > 0;
  const displayedPnl = showingBatch ? totals.pnl : latestResult ? cents(latestResult.won - latestResult.cost) : 0;

  return (
    <section aria-label="Draw" className={cn(feedback.surface, "relative isolate min-h-0 flex-1 overflow-hidden bg-background")}>
      <div className={feedback.topShade} aria-hidden="true" />
      <div className={feedback.summary}>
        <div className={feedback.market}>
          <Popover>
            <PopoverTrigger render={<Button variant="ghost" aria-label="Change asset: Bitcoin" className={feedback.assetButton} />}>
              <TokenAvatar symbol="BTC" className="size-9 sm:size-10" />
              <span className={feedback.marketName}><span>Bitcoin <ChevronDownIcon className="size-3" strokeWidth={2.4} /></span><strong className="figures">{price ? <Price value={price} /> : "Connecting…"}</strong></span>
            </PopoverTrigger>
            <PopoverPopup align="start" sideOffset={10} className="w-64">
              <PopoverTitle>Choose asset</PopoverTitle>
              <PopoverClose render={<Button variant="ghost" className="mt-3 h-14 w-full justify-start px-2" />} aria-label="Bitcoin, selected">
                <TokenAvatar symbol="BTC" className="size-8" /><span className="flex flex-col items-start"><span>Bitcoin</span><span className="text-xs text-muted-foreground">BTC / USD</span></span><CheckIcon className="ml-auto text-primary" />
              </PopoverClose>
            </PopoverPopup>
          </Popover>
        </div>
        <div className={feedback.accounts}>
          <div className={feedback.balance} aria-label="Practice balance">
            <span className={feedback.eyebrow}>Balance</span>
            <span className={cn(feedback.balanceValue, "figures", gained ? "text-success-foreground" : "text-foreground")}><CrispNumber value={money(state.balance)} /></span>
          </div>
          <div className={feedback.pnl} aria-label="Profit and loss">
            <span className={feedback.eyebrow}>{totals.drawings ? "This round" : "Last round"}</span>
            <span className={cn(feedback.pnlValue, "figures", displayedPnl > 0 ? "text-success-foreground" : displayedPnl < 0 ? "text-destructive-foreground" : "text-foreground")}>
              <CrispNumber value={signed(displayedPnl)} />
            </span>
          </div>
        </div>
      </div>

      <div className="absolute inset-0">
          {lib ? <Stage onViewport={onViewport} className="absolute inset-0 size-full" game={game} onPlace={onPlace} onPreview={onPreview} /> : null}
          {owner === false ? (
            <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-background/80 backdrop-blur-sm" role="status">
              <p className="text-sm text-muted-foreground">The game is open in another tab.</p>
              <Button onClick={() => takeOver.current?.()}>Play here</Button>
            </div>
          ) : null}
          {!fresh ? (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center" role="status">
              <p className="text-sm text-muted-foreground">{!lib ? "Getting the chart ready…" : "Waiting for live prices…"}</p>
            </div>
          ) : null}

          {/* While drawing: what the stroke has put in play, and the most it can win. */}
          {preview ? (
            <div className={feedback.floatPill} role="status">
              {preview.inPlay.length ? (
                <>
                  <span>In play <strong>{money(preview.cost)}</strong></span>
                  <span>Could win <strong className={feedback.win}>{money(preview.high)}</strong></span>
                  <span className="max-sm:hidden">Up to <strong className={feedback.win}>{fmtMultiple(preview.multipleHigh)}</strong></span>
                </>
              ) : (
                <span>Move to a spot with a multiplier on it</span>
              )}
            </div>
          ) : !state.taught && fresh && owner !== false ? (
            <div className={feedback.hintPill}>Draw to the right of the line</div>
          ) : null}

          {/* A finished drawing, for a moment: what it came to, and a way to share it. */}
          {result && !preview ? (
            <div className={cn(feedback.notice, feedback.roundCard)} key={result.key} role="status">
              {!result.voided ? (
                <>
                  <div>
                    <span className={feedback.roundLabel}>Round over</span>
                    <span className={cn(feedback.roundValue, result.won > result.cost ? "text-success-foreground" : result.won < result.cost ? "text-destructive-foreground" : "text-foreground")}>{signed(cents(result.won - result.cost))}</span>
                    <span className={cn(feedback.roundLabel, "figures")}>{money(result.cost)} in, {money(result.won)} back{result.hits > 0 ? ` · ${Math.round(100 * result.hits / result.points)}% hit` : ""}</span>
                  </div>
                  <Button className="h-11 shrink-0 rounded-full border-0 bg-secondary px-4 font-semibold text-[15px] sm:h-11" onClick={() => void share(cents(result.won - result.cost))} variant="secondary"><ShareIcon className="size-[18px]" />Share</Button>
                </>
              ) : (
                <span className="text-[15px] text-muted-foreground">The price moved before it opened. Nothing spent.</span>
              )}
            </div>
          ) : null}
      </div>

      {returnedInk && !preview && !result ? <div key={returnedInk.id} role="status" className={feedback.bottomPill}>Unpriced ink · <span className="figures font-semibold text-foreground">{money(returnedInk.amount)} refunded</span></div> : null}
      <div className={feedback.bottomShade} aria-hidden="true" />
      <footer className={feedback.toolbar}>
        <Button aria-label="Settings" aria-haspopup="dialog" className={feedback.settingsButton} onClick={() => setSettingsOpen(true)} size="icon" variant="outline"><SlidersHorizontalIcon strokeWidth={1.8} /></Button>
        {controls}
      </footer>

      <Sheet onOpenChange={setSettingsOpen} open={settingsOpen}>
        <SheetPopup className="sm:max-w-sm" side="right" variant="inset">
          <SheetHeader className="px-4 pt-6 sm:px-6 sm:pt-8"><SheetTitle className="font-bold text-xl">Settings</SheetTitle><SheetDescription className="sr-only">Sound, haptics, your balance and your drawings</SheetDescription></SheetHeader>
          <SheetPanel className="flex flex-col gap-3.5 px-4 pb-10 sm:px-6">
            <div className="divide-y divide-border overflow-hidden rounded-[14px] bg-muted">
              <ToggleRow checked={state.sound} detail="Pen, hits and round results" onChange={(on) => setPractice({ sound: on })} title="Sounds" />
              <ToggleRow checked={state.haptics} detail="A tap when ink goes in and when it hits" onChange={(on) => setPractice({ haptics: on })} title="Haptics" />
              <ToggleRow checked={dark} detail="Black paper, brighter ink" onChange={setDark} title="Dark mode" />
            </div>
            <div className="flex min-h-[60px] items-center justify-between gap-3 rounded-[14px] bg-muted px-4 py-2"><div className="flex flex-col"><span className="text-[13px] text-muted-foreground">Practice balance</span><span className="figures font-semibold text-[17px]">{money(state.balance)}</span></div><DepositButton className="bg-raised" onDeposit={amount => setPractice(st => ({ balance: cents(st.balance + amount) }))} /></div>
            <div className="divide-y divide-border overflow-hidden rounded-[14px] bg-muted">
              <button className={navRow} onClick={() => { setSettingsOpen(false); setListOpen(true); }} type="button">Your drawings<span className="figures ml-auto text-muted-foreground">{state.history.length}</span><ChevronRightIcon className="size-4 text-faint" /></button>
              <button className={cn(navRow, "max-sm:hidden")} onClick={() => void expand()} type="button">{fullscreen ? "Exit full screen" : "Full screen"}<ChevronRightIcon className="ml-auto size-4 text-faint" /></button>
              <button className={navRow} onClick={() => { setSettingsOpen(false); setHelp(true); }} type="button">How it works<ChevronRightIcon className="ml-auto size-4 text-faint" /></button>
            </div>
          </SheetPanel>
        </SheetPopup>
      </Sheet>

      <Sheet onOpenChange={setListOpen} open={listOpen}>
        <SheetPopup className="sm:max-w-md" side="right" variant="inset">
          <SheetHeader className="px-6 pt-8">
            <SheetTitle className="font-bold text-xl">Your drawings</SheetTitle>
            <SheetDescription>
              Practice balance <span className="figures text-foreground"><CrispNumber value={money(state.balance)} /></span>
              {state.streak > 0 ? ` · ${state.streak} in a row with a hit` : ""}
            </SheetDescription>
          </SheetHeader>
          <SheetPanel className="flex flex-col gap-2 px-6 pb-8">
            {state.history.length ? (
              <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-[14px] bg-muted">
                {state.history.map((r) => {
                  const net = cents(r.won - r.cost);
                  return (
                    <li className="flex items-center justify-between gap-3 px-4 py-3 text-sm" key={r.id}>
                      <span className="text-muted-foreground">
                        {new Date(r.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                        <span className="figures">
                          {" "}
                          · {r.dots > 0 ? Math.round(100 * r.hits / r.dots) : 0}% hit · {money(r.cost)}
                        </span>
                        {r.best ? <span className="figures"> · best {fmtMultiple(r.best)}</span> : null}
                      </span>
                      <span className={cn("figures font-medium", net > 0 ? "text-success-foreground" : "text-muted-foreground")}>{signed(net)}</span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">Nothing yet. Draw ahead of the price and your drawings land here.</p>
            )}
            {broke ? null : (
              <Button className="mt-2 self-start" onClick={() => setPractice({ balance: START_BALANCE })} variant="ghost">
                Reset practice money to {money(START_BALANCE)}
              </Button>
            )}
          </SheetPanel>
        </SheetPopup>
      </Sheet>

      <Sheet onOpenChange={setHelp} open={help}>
        <SheetPopup className="sm:max-w-md" side="right" variant="inset">
          <SheetHeader className="px-6 pt-8">
            <SheetTitle className="font-bold text-xl">How it works</SheetTitle>
            <SheetDescription>Practice money, on the real Bitcoin price.</SheetDescription>
          </SheetHeader>
          <SheetPanel className="flex flex-col gap-4 px-6 pb-8 text-sm leading-relaxed">
            <p>Draw ahead of the live price. One full dot at your selected pen size costs the amount under Per dot. A longer stroke costs more; retracing ink in the same drawing adds no cost. The total cost rounds up to the next cent, once per drawing.</p>
            <p>Every part of your ink pays a rung of the ladder on the map, 1.1× up to 128× what it cost, if the price crosses it in its second. Rungs come from the chance the price reaches that spot then: near the price and soon is likely and pays little; far away pays a lot. A wider pen puts more ink, and more money, on the same spots; it never changes what a spot pays. Only solid blue ink is in play. A hit pays immediately.</p>
            <p>Ink is bet as you draw it, not when you lift the pen: each new bit opens on the next second at the price for that moment, so a slow stroke is not priced on where the market has gone by the time you finish. Going back over your own ink costs nothing. The drawing’s cost rounds up to the cent once, over all of it.</p>
            <p>Live P&amp;L shows payouts received minus the cost of settled ink. Placing a drawing reserves its stake from your balance immediately, but pending sections are not counted as losses. Hits settle when touched; misses settle after their time window closes. Refunds are not profit. This is not a cash-out value. Once a drawing finishes, its final result appears in your history.</p>
            <p>Ink starts counting one to two seconds ahead: everything right of the dashed wait line always counts, and it reaches {RULES.horizon} seconds ahead.</p>
            <p className="text-muted-foreground">Odds use historical Bitcoin paths, price distance, time, volatility and momentum. Every part pays a rung of one ladder, 1.1× to 128×, set by its chance: ink exactly on a rung returns {Math.round(difficulty(level).ladderBest * 100)}¢ per dollar, and everywhere else rounds down to the rung below, a little less on the side the price is moving towards. Nothing pays under {difficulty(level).ladderFloor}×. This is not a guaranteed return. Hits are resolved using one-second price ranges. Your balance is practice money saved in this browser.</p>
            {house ? (
              <div className="flex flex-col gap-3 rounded-[14px] bg-muted p-4">
                <div className="flex items-baseline justify-between">
                  <p className="font-medium">Difficulty</p>
                  <p className="figures font-semibold text-lg">
                    {level}
                    {state.houseDifficulty === null ? <span className="font-normal text-muted-foreground text-xs"> default</span> : null}
                  </p>
                </div>
                <Slider aria-label="Difficulty" max={100} min={0} onValueChange={(v) => setPractice({ houseDifficulty: Array.isArray(v) ? v[0] : v })} step={5} value={level} />
                <p className="figures text-muted-foreground text-xs">
                  Best ink {Math.round(difficulty(level).ladderBest * 100)}¢ a dollar · pays {difficulty(level).ladderFloor}× to 128× · momentum margin {difficulty(level).momentumMargin}
                </p>
                <p className="text-muted-foreground text-xs">For the house, while it is practice money. Drawings already open keep what they opened on.</p>
                {state.houseDifficulty !== null ? (
                  <Button className="self-start" onClick={() => setPractice({ houseDifficulty: null })} size="sm" variant="ghost">
                    Back to the game&rsquo;s default, {DIFFICULTY}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </SheetPanel>
        </SheetPopup>
      </Sheet>
    </section>
  );
}
