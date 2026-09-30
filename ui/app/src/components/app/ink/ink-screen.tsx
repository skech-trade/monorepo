"use client";

import { CheckIcon, ChevronDownIcon, ChevronRightIcon, SlidersHorizontalIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { DIFFICULTY, difficulty, features, type Field, type Library, openFor, readLibrary, RULES, setDifficulty, stepFor } from "@skech/core/dots";
import { areaCostOf, cost, decided, isArea, liveInkTotals, judge, open, openOn, INK_EDGE_CELLS, drawingLayout, INK_CELL, placeInk, refund, type InkBet, type Stroke, won } from "@skech/core/ink";
import { POINT_PRICES, roundedTerms as areaTerms } from "@skech/core/odds";
import { betIdOf, encodeStroke, fromE8, gridStep, LATE_MS, stakeOf, strokeHash, toE6, toE8, toSections, TYPES, unitFor } from "@skech/core/chain";
import { hashTypedData, keccak256, stringToHex, type Hex } from "viem";
import { domain as gameDomain } from "@/lib/chain";
import { type Hello, type Incoming } from "@/lib/relayer";
import { useChain } from "./chain-context";

import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Popover, PopoverClose, PopoverPopup, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { setDark, useDark } from "@/components/app/theme-toggle";

import { Sheet, SheetDescription, SheetHeader, SheetPanel, SheetPopup, SheetTitle } from "@/components/ui/sheet";
import { type Market, useEngine } from "@/lib/engine";
import { cents, practice, record, setPractice, usePractice } from "@/lib/practice";
import { feel, sound } from "@/lib/feel";
import { money, signed } from "@/lib/money";
import { scoreboard, useScoreboard } from "@/lib/scoreboard";
import { ScoreboardSheet } from "./scoreboard-sheet";
import { addChange, Ledger } from "./ledger";
import { WalletButton } from "./wallet-button";
import { cn } from "@/lib/utils";
import { track } from "@/lib/analytics";
import { fmtMultiple, type Game, type Placed, type Preview, Stage } from "./stage";
import { HapticHost } from "./haptic-host";
import { UpdateReady } from "./update-ready";
import { TokenAvatar } from "@/components/app/market-header";
import { DepositButton, InkControls } from "./ink-controls";
import feedback from "./drawing-feedback.module.css";
import { CrispNumber } from "./crisp-number";
import { introReady } from "./ink-intro";
import { homeBarRoom, HomeScreenBar, HomeScreenSheet, useHomeScreen } from "./home-screen";
import { forReal, Onboarding, useOnboarding } from "./onboarding";
import { SignInButton } from "@/components/app/sign-in";
import { useGate } from "./deposit-modal";
import { useAccount } from "@/components/app/auth";

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
/** A piece sent to the chain and not heard of by then is let go. */
const CHAIN_ANSWER_MS = 8000;
/** The chain's name for a drawing: 64 bits of the line's id. */
const drawingIdOf = (line: string) => BigInt(keccak256(stringToHex(line)).slice(0, 18));
/** A piece's number within its drawing, from its id `line:index`. */
const pieceIndexOf = (id: string) => Number(id.slice(id.lastIndexOf(":") + 1));

/** A piece on its way to the chain: its bet, its stake, and what it takes to send its ink again. */
type SentPiece = { id: string; stakeUsd: number; drawing: bigint; stroke: Hex; tries: number };
/**
 * Refusals that mean nothing was placed and the same ink can go again on the
 * next second: too late for its second, a price quote that aged on the way,
 * a difficulty that changed, a relayer still starting. Not "no answer": that
 * piece may have gone in.
 */
const RESEND = /^(Too late for that second|Price seen is stale|Difficulty|Waiting for live prices|Starting up|No price to open on|Late$|StalePrice$)/;
/** How many times a piece is sent again before its ink is let go. */
const RESENDS = 2;
const RESEND_BASE = 100_000;

type Chain = ReturnType<typeof useChain>;
/** A piece as it is signed, and as it goes on the wire, with the chain's numbers as strings. */
function pieceFor(ch: Chain, level: number, drawing: bigint, index: number, openAt: number, perDot: number, unit: number, quote: { price: string | number; time: string | number }, sections: ReturnType<typeof toSections>, stroke: Hex) {
  const piece = {
    player: ch.player!,
    drawing,
    index,
    market: ch.hello!.market.id,
    difficulty: ch.hello!.difficulty ?? level,
    openAt: BigInt(openAt),
    perDot: toE6(perDot),
    unit: toE8(unit),
    priceSeen: BigInt(quote.price),
    priceTime: BigInt(quote.time),
    sections,
    strokeHash: strokeHash(stroke),
  };
  const wire = { ...piece, drawing: drawing.toString(), openAt: piece.openAt.toString(), perDot: piece.perDot.toString(), unit: piece.unit.toString(), priceSeen: piece.priceSeen.toString(), priceTime: piece.priceTime.toString(), sections: sections.map((s) => ({ second: s.second, lo: s.lo.toString(), hi: s.hi.toString(), stake: s.stake.toString() })) };
  return { piece, wire };
}
/** Sign a piece with the session key and send it; `fail` hears why, if the relayer turns it away. */
function sendPiece(ch: Chain, { piece, wire }: ReturnType<typeof pieceFor>, stroke: Hex, priceSig: Hex, fail: (why: string) => void) {
  const { key: sessionKey, client } = ch;
  void (async () => {
    try {
      const sig = await sessionKey!.sign(hashTypedData({ domain: gameDomain!, types: TYPES, primaryType: "Piece", message: piece }));
      const ack = await client.request({ type: "piece", piece: wire, sessionSig: sig, priceSig, stroke }, (m): m is Extract<Incoming, { type: "ack" }> => m.type === "ack" && m.drawing === wire.drawing && m.index === piece.index, 10_000);
      if (!ack || !ack.ok) fail(ack?.why ?? "No answer. Your money is back.");
    } catch (e) {
      fail(String((e as Error).message ?? e));
    }
  })();
}
/** On chain a hit pays its gross less 10% of the profit: shown that way here too, as each hit lands. */
function lessProfitFee(bet: InkBet, before: InkBet, profitFeeBps: number): InkBet {
  let touched = false;
  const cells = bet.cells.map((c, k) => {
    if (c.status !== "hit" || before.cells[k]?.status === "hit" || c.paid === undefined) return c;
    touched = true;
    const stake = bet.perUnit * c.area;
    return { ...c, paid: c.paid - Math.max(0, c.paid - stake) * (profitFeeBps / 10_000) };
  });
  return touched ? { ...bet, cells } : bet;
}

/** What skech keeps, in the game's own numbers as the relayer sends them; without them, that it keeps some, and no number that could be wrong. */
const feesLine = (config: Hello["config"] | undefined) =>
  config ? `skech keeps ${config.feeBps / 100}% of every stake and ${config.profitFeeBps / 100}% of every win.` : "skech keeps a share of every stake and of every win.";

/** A price with its cents quieter than its dollars. */
const Price = ({ value }: { value: number }) => {
  const [whole, part] = money(value).split(".");
  return <><CrispNumber value={whole} /><span className={feedback.cents}>.{part}</span></>;
};

/*
  Two things on this screen change faster than it should re-render: the price, with every trade, and the
  terms of the stroke under the pen, with every move. Each is its own small component that listens for its
  own value, so the screen around them renders only when something else changes.
*/

/** The price in the market row, from the feed as each trade batch lands. */
function LivePrice({ feed }: { feed: Market }) {
  const price = useSyncExternalStore(feed.subscribe, () => feed.ticks.at(-1)?.p ?? feed.bars.at(-1)?.c ?? 0, () => 0);
  return price ? <Price value={price} /> : <Skeleton className="my-[3px] h-6 w-32 rounded-md" />;
}

/** A value that changes faster than the screen should re-render, for the one part that shows it. */
type Signal<T> = { get: () => T; set: (next: T) => void; subscribe: (fn: () => void) => () => void };
function signal<T>(initial: T): Signal<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next) => {
      value = next;
      for (const fn of listeners) fn();
    },
    subscribe: (fn) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
  };
}

/** While drawing: what the stroke has put in play, and the most it can win. */
function PreviewPill({ preview: store }: { preview: Signal<Preview | null> }) {
  const preview = useSyncExternalStore(store.subscribe, store.get, store.get);
  if (!preview) return null;
  return (
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
  );
}

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
  const feed = useEngine();
  const feedRef = useRef(feed);
  useEffect(() => {
    feedRef.current = feed;
  });
  const state = usePractice();
  /*
    Real money: the game on chain, through the relayer. Read through a ref
    inside the effects and the pen, which run for the life of the page.
  */
  const chain = useChain();
  const chainRef = useRef(chain);
  useEffect(() => {
    chainRef.current = chain;
  });
  const real = chain.real;
  /** Pieces sent to the chain, by the chain's name for them: which local bet each is, and what was staked. */
  const chainBets = useRef(new Map<Hex, SentPiece>());
  /** Pieces sent again this visit: their indices, well clear of any line's own. */
  const resent = useRef(0);
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

  /* The stroke's terms, for the pill; the screen itself only needs to know whether there is a stroke. */
  const [preview] = useState(() => signal<Preview | null>(null));
  const [previewing, setPreviewing] = useState(false);
  const [help, setHelp] = useState(false);
  const [returnedInk, setReturnedInk] = useState<{ id: string; amount: number } | null>(null);
  useEffect(() => {
    if (!returnedInk) return;
    const timer = setTimeout(() => setReturnedInk(null), 3200);
    return () => clearTimeout(timer);
  }, [returnedInk]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const dark = useDark();
  /** How hard the game is here: on chain, what the game contract says; else what the house set on this browser, or the game's own. */
  const level = real && chain.hello?.difficulty !== null && chain.hello?.difficulty !== undefined ? chain.hello.difficulty : state.houseDifficulty ?? DIFFICULTY;
  /* The house's controls show in development, or with ?house in the address. */
  const [house] = useState(() => typeof window !== "undefined" && (process.env.NODE_ENV !== "production" || new URLSearchParams(window.location.search).has("house")));
  const [live, setLive] = useState(0);
  const [result, setResult] = useState<{ key: string; won: number; cost: number; hits: number; points: number; voided: boolean; best?: number; streak?: number } | null>(null);
  useEffect(() => {
    if (!result) return;
    // A win stays long enough to enjoy; a loss is said once and gets out of the way.
    const t = setTimeout(() => setResult(null), result.won > result.cost ? 4200 : 2400);
    return () => clearTimeout(t);
  }, [result]);
  const [fresh, setFresh] = useState(false);
  const me = useAccount();
  // The way in holds its ink over the screen until there are live prices to show, and it is known who is playing:
  // the first screen is the right one, never a sign-in flashed at someone already signed in.
  useEffect(() => {
    if (fresh && me.ready) introReady();
  }, [fresh, me.ready]);
  // Once a load: how long until the game could be played, and if it is slow, which part is.
  const readyAt = useRef<number | null>(null);
  const health = useRef({ prices: false, account: false, relayer: false, signedIn: false });
  useEffect(() => {
    health.current = { prices: fresh, account: me.ready, relayer: chain.real, signedIn: me.signedIn };
  }, [fresh, me.ready, me.signedIn, chain.real]);
  useEffect(() => {
    if (!fresh || !me.ready || readyAt.current !== null) return;
    readyAt.current = performance.now();
    track("app_ready", { ms: Math.round(readyAt.current), signed_in: me.signedIn });
  }, [fresh, me.ready, me.signedIn]);
  useEffect(() => {
    const t = setTimeout(() => {
      const h = health.current;
      if (h.prices && h.account && (!forReal || !h.signedIn || h.relayer)) return;
      track("connect_slow", { prices: h.prices, account: h.account, relayer: h.relayer, signed_in: h.signedIn });
    }, 10_000);
    return () => clearTimeout(t);
  }, []);
  /* The balance shows green for a moment when a hit pays into it. What paid lands in the changes under it. */
  const [gained, setGained] = useState<number>(0);
  useEffect(() => {
    if (!gained) return;
    const t = setTimeout(() => setGained(0), 1400);
    return () => clearTimeout(t);
  }, [gained]);
  /* Hits close together climb: each one within a few seconds of the last sounds a step higher. */
  const hitRun = useRef({ n: 0, at: 0 });
  /** Drawings whose first piece the chain has confirmed, so each is sealed once. */
  const sealed = useRef(new Set<string>());
  const game = useRef<Game>({ bars: [], ticks: [], skew: 0, field: null, placeLead: 0, step: 1, priceStep: 1, marketStep: 1, viewport: { width: 1280, height: 800 }, displayPrice: 0, perDot: state.perDot, pen: state.brush, cell: INK_CELL, bets: [], quote: null, fx: [], dark: false });

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

  // On chain a piece opens a margin later than it is drawn; the map, the quote and the placement all use the same one.
  useEffect(() => {
    game.current.placeLead = real ? LATE_MS : 0;
  }, [real]);

  useEffect(() => {
    const g = game.current;
    g.perDot = state.perDot;
    // How hard the game is: every drawing priced from now on, and the map, use it.
    setDifficulty(level);
    if (g.field && g.field.rtp !== difficulty(level).rtp) g.field = null;
    g.pen = state.brush;
    g.cell = INK_CELL;
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
      // The map is asked for on the price grid (`size` below), not the screen's step: check it against the same.
      if (Math.abs(e.data.field.step - g.priceStep * g.cell) > 1e-9 || e.data.field.rtp !== difficulty(level).rtp || e.data.field.edgeCells !== INK_EDGE_CELLS) return;
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
        // Ink is priced and judged on a grid of the market step, the same on every screen and on chain.
        g.priceStep = gridStep(g.marketStep);
      }
      // Use the same fine price slices for every pen.
      const size = g.priceStep * g.cell;
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
      const l = areaTerms(g.field, Date.now() + g.skew + g.placeLead, g.drawing?.priceStep ?? g.priceStep, g.drawing?.perDot ?? g.perDot).line(st);
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
    const played = { pen: practice().brush, per_dot: practice().perDot, real: chainRef.current.real };
    if (!t.points) {
      track("round_finished", { ...played, voided: true, cost: 0, won: 0, net: 0 });
      return setResult({ key: line, won: 0, cost: 0, hits: 0, points: 0, voided: true });
    }
    track("round_finished", { ...played, voided: false, cost: cents(t.cost), won: cents(t.won), net: cents(t.won - t.cost), hits: t.hits, dots: t.points, hit_share: Math.round((100 * t.hits) / t.points), best: t.best });
    record({ id: line, at: t.at, cost: cents(t.cost), won: cents(t.won), hits: t.hits, dots: t.points, best: t.best });
    const streak = scoreboard().streak;
    setResult({ key: line, won: cents(t.won), cost: cents(t.cost), hits: t.hits, points: t.points, voided: false, best: t.best, streak });
    // Only a round that came out ahead is heard and felt: a chord, fuller for a big one. A loss passes in silence.
    if (t.won > t.cost) feel("win", { ratio: t.cost > 0 ? t.won / t.cost : 1 });
    else if (!t.hits) hitRun.current.n = 0;
  };
  /** A piece the chain refused, or never answered: its ink is let go and its stake is back. */
  const gate = useGate();
  /** A piece was refused for want of money: offer the deposit sheet once every drawing is settled. */
  const topUp = useRef(false);
  const gateRef = useRef(gate);
  useEffect(() => {
    gateRef.current = gate;
  }, [gate]);
  const letGoRef = useRef<(key: Hex, why: string) => void>(() => {});
  /*
    A piece turned away for a reason that placed nothing (too late for its
    second, a price that aged on the way, a new difficulty) goes again at
    once, on the next second: the same ink, a fresh quote, a new index. Ink
    that is by then too close to the price stays out, and its stake comes
    back. A refused piece used to leave its ink faint for good: the next
    piece of the line only carries what was drawn after it.
  */
  const resend = useCallback((key: Hex, why: string): boolean => {
    const g = game.current;
    const ch = chainRef.current;
    const sent = chainBets.current.get(key);
    const quote = feedRef.current.quote;
    if (!sent || sent.tries >= RESENDS || !RESEND.test(why)) return false;
    if (!quote?.message || !quote.signature || !ch.hello || !ch.player || !ch.key || !gameDomain || !ch.sessionOk) return false;
    const i = g.bets.findIndex((b) => b.id === sent.id);
    if (i < 0 || g.bets[i].status !== "opening") return false;
    const bet = g.bets[i];
    const line = bet.group ?? bet.id;
    const openAt = openFor(Date.now() + g.skew + g.placeLead);
    const drawn = bet.drawn.filter((c) => c.t >= openAt + 1000);
    // The bet's own grid: its cells are one unit tall.
    const unit = bet.step * (bet.cell ?? INK_CELL);
    const sections = toSections(drawn, openAt, toE6(bet.perUnit), unit);
    if (!sections.length) return false;
    const stakeUsd = Number(stakeOf(sections)) / 1e6;
    const index = RESEND_BASE + resent.current++;
    const next = betIdOf(ch.player, sent.drawing, index);
    const signed = pieceFor(ch, level, sent.drawing, index, openAt, bet.perUnit, unit, quote.message, sections, sent.stroke);
    chainBets.current.delete(key);
    chainBets.current.set(next, { ...sent, id: `${line}:${index}`, stakeUsd, tries: sent.tries + 1 });
    // The first stake back, the second out: only what dropped out shows, as returned.
    ch.nudge(sent.stakeUsd - stakeUsd);
    const back = cents(sent.stakeUsd - stakeUsd);
    if (back > 0) addChange(back, "back");
    g.bets[i] = { ...bet, id: `${line}:${index}`, openAt, drawn, charged: stakeUsd };
    track("piece_resent", { why: why.slice(0, 120), tries: sent.tries + 1 });
    if (process.env.NODE_ENV !== "production") console.warn(`[ink] piece ${sent.id} refused (${why}); sent again as ${index}, opening ${openAt}`);
    sendPiece(ch, signed, sent.stroke, quote.signature, (w) => letGoRef.current(next, w));
    updateTotals();
    return true;
  }, [level, updateTotals]);
  const letGo = useCallback((key: Hex, why: string) => {
    const g = game.current;
    if (resend(key, why)) return;
    track("piece_refused", { why: why.slice(0, 120) });
    // Out of money: the deposit sheet, but not while drawings are still in play, which may yet pay (below).
    if (/not enough|balance|allowance/i.test(why)) topUp.current = true;
    feel("nope");
    const sent = chainBets.current.get(key);
    chainBets.current.delete(key);
    if (!sent) return;
    chainRef.current.nudge(sent.stakeUsd);
    addChange(sent.stakeUsd, "back");
    const i = g.bets.findIndex((b) => b.id === sent.id);
    if (i >= 0 && g.bets[i].status === "opening") {
      g.bets[i] = { ...g.bets[i], status: "void", why };
      const line = g.bets[i].group ?? g.bets[i].id;
      const t = tally(line, g.bets[i].placedAt);
      t.open--;
      if (t.open <= 0 && !drawing.current.has(line)) closeLine(line);
      setReturnedInk({ id: sent.id, amount: cents(sent.stakeUsd) });
      updateTotals();
    }
    if (process.env.NODE_ENV !== "production") console.warn(`[ink] piece ${sent.id} not placed: ${why}`);
  }, [updateTotals, resend]);
  useEffect(() => {
    letGoRef.current = letGo;
  }, [letGo]);
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
  /*
    Run for every trade batch, straight from the feed, not from a render: the screen does not re-render for a
    trade. Everything it reads is in refs or the feed's store, so a callback from an earlier render judges the
    same as a fresh one would; it is made again only when the paths, the tab's ownership or the feed change.
  */
  const judgeTrades = useCallback(() => {
    const { bars, ticks, skew } = feed;
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
      // Practice drawings come back from storage; real ones live on chain and are not.
      for (const bet of chainRef.current.real ? [] : practice().open) {
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
      const onChain = chainRef.current.real && chainRef.current.player ? chainBets.current.has(betIdOf(chainRef.current.player, drawingIdOf(bet.group ?? bet.id), pieceIndexOf(bet.id))) : false;
      if (bet.status === "opening" && onChain) {
        // A piece on its way to the chain: the chain prices it, and says so through the relayer. Not heard from in time, it is let go.
        if (nowMs >= bet.openAt + CHAIN_ANSWER_MS) {
          const key = betIdOf(chainRef.current.player!, drawingIdOf(bet.group ?? bet.id), pieceIndexOf(bet.id));
          const sent = chainBets.current.get(key);
          chainBets.current.delete(key);
          if (sent) {
            chainRef.current.nudge(sent.stakeUsd);
            addChange(sent.stakeUsd, "back");
          }
          bet = { ...bet, status: "void", why: "No answer. Your money is back." };
          if (process.env.NODE_ENV !== "production") console.warn(`[ink] piece ${bet.id} was never answered by the relayer`);
          changed = true;
        }
      } else if (bet.status === "opening" && nowMs >= bet.openAt + OPEN_AFTER_MS) {
        // Off its second's map when that is in; on the paths, here, if it is not by the time it has to be.
        const quick = g.field ? openOn(bet, g.field) : null;
        if (!quick && nowMs < bet.openAt + OPEN_BY_MS) {
          g.bets[i] = bet;
          continue;
        }
        const drawn = bet.drawn.length;
        bet = quick ?? open(bet, lib, bars);
        // Why part of a stroke is faint rather than solid, when it happens: for finding out, in development only.
        if (process.env.NODE_ENV !== "production" && (bet.status === "void" || bet.cells.length < drawn))
          console.warn(`[ink] piece ${bet.id} opened ${bet.status}: ${bet.status === "void" ? bet.why : `${drawn - bet.cells.length} of ${drawn} sections refused`}`);
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
          if (chainRef.current.real) bet = lessProfitFee(bet, before, chainRef.current.hello?.config?.profitFeeBps ?? 1000);
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
            // Where it landed, what this hit paid: always a gain. What the
            // drawing came to, win or lose, is the round's card when it ends.
            const paid = Math.floor((won(bet) - won(before)) * 100 + 1e-8) / 100;
            const best = Math.max(...fresh2.map((d) => d.multiple * (isArea(bet.model) ? d.area : 1)));
            const lo = Math.min(...fresh2.map((d) => d.lo));
            const hi = Math.max(...fresh2.map((d) => d.hi));
            // Every hit gets its own toast, sound and touch: each one is a win. Hits judged late, from bars of prices
            // restored after a reload, are paid but not celebrated: ten at once would be noise, not news.
            const fresh3 = nowMs - (bar.t + 1000) < 3000;
            if (fresh3) g.fx.push({ kind: "hit", t: fresh2[0].t + 500, price: Math.min(hi, Math.max(lo, bar.c)), born: performance.now(), text: paid > 0 ? `+${money(paid)}` : undefined, line, big: best >= 10 });
            if (fresh3) {
              const run = hitRun.current;
              run.n = performance.now() - run.at < 6000 ? run.n + 1 : 0;
              run.at = performance.now();
              feel(best >= 10 ? "big" : "hit", { multiple: best, streak: run.n });
            }
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
    if (credit) {
      if (chainRef.current.real) chainRef.current.nudge(credit);
      else setPractice((s) => ({ balance: cents(s.balance + credit) }));
    }
    if (credit > 0) {
      setGained(performance.now());
      addChange(cents(credit), "win");
    }
    if ((changed || credit) && !chainRef.current.real) setPractice({ open: g.bets.filter((b) => !decided(b)) });
    setLive(new Set(g.bets.filter((b) => !decided(b)).map((b) => b.group ?? b.id)).size);
    // Keep finished drawings only as long as their dots are still fading.
    g.bets = g.bets.filter((b) => !decided(b) || b.cells.some((d) => d.t + 3000 > nowMs));
    updateTotals();
  }, [feed, lib, owner, updateTotals]);
  useEffect(() => {
    judgeTrades();
    return feed.subscribe(judgeTrades);
  }, [feed, judgeTrades]);

  /*
    Ink is bet as it is drawn: every few moments while the pen is down, the
    ink added since the last piece opens on the next second, priced on what
    is known then. A long stroke is not priced on where the market was when
    the pen lifted, and ink near now is not lost to the wait. The drawing's
    stake rounds up once over its pieces (each piece takes the growth of the
    rounded total), so cost does not depend on how often the pen is read.
  */
  const onPlace = useCallback(
    (stroke: Stroke, line: string, done: boolean): Placed => {
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
      const settings = g.drawing ?? { step: g.step, priceStep: g.priceStep, perDot: practice().perDot };
      const placedAt = Date.now() + g.skew;
      const snap: Stroke = { ...stroke, pts: stroke.pts.slice() };
      const ch = chainRef.current;
      if (forReal && !ch.real) return ch.player ? "Connecting…" : "Sign in to play";
      if (ch.real && !ch.sessionOk) return "Getting ready, one moment";
      // On chain a piece drawn in the last moments of a second opens on the one after, so it is never late.
      const bet = placeInk(snap, d.prev, settings.perDot, settings.priceStep, placedAt + g.placeLead, `${line}:${d.pieces}`, line, INK_EDGE_CELLS);
      if (!bet) {
        finish();
        return done && !d.pieces ? "Draw ahead of the wait line" : null;
      }
      const area = d.area + bet.drawn.reduce((n, c) => n + c.area, 0);
      let charge = cents(areaCostOf(settings.perDot, area) - d.charged);
      if (ch.real) {
        // The chain takes the stake exactly, in millionths: no rounding to the cent.
        const unit = unitFor(g.marketStep);
        const sections = toSections(bet.drawn, bet.openAt, toE6(settings.perDot), unit);
        const stake = stakeOf(sections);
        if (!sections.length) {
          finish();
          return done && !d.pieces ? "Draw ahead of the wait line" : null;
        }
        charge = Number(stake) / 1e6;
        if (charge > ch.balance) {
          finish();
          // The line ends here: nothing further of it can go in. Some money, just not this much: the way out is
          // a smaller price per dot (a long line on a big screen is many dots), not the deposit sheet.
          track("balance_ran_out", { per_dot: settings.perDot, pieces: d.pieces, balance: ch.balance });
          // Nothing at all left: the deposit sheet once this drawing and any others are settled.
          if (ch.balance < POINT_PRICES.values[0]) topUp.current = true;
          return { stop: ch.balance >= POINT_PRICES.values[0] ? "Balance used up here · lower the price per dot" : "Not enough USDC in the game" };
        }
        const quote = feedRef.current.quote;
        if (!quote?.message || !quote.signature || !ch.hello || !ch.player || !ch.key || !gameDomain) {
          finish();
          return "Waiting for a signed price";
        }
        const drawing = drawingIdOf(line);
        const key = betIdOf(ch.player, drawing, d.pieces);
        const from = d.prev?.pts.length ?? 0;
        const stroke = encodeStroke({ t0: snap.t0, p0: snap.p0, rt: snap.rt, rp: snap.rp, from, pts: snap.pts.slice(from) });
        const signed = pieceFor(ch, level, drawing, d.pieces, bet.openAt, settings.perDot, unit, quote.message, sections, stroke);
        chainBets.current.set(key, { id: bet.id, stakeUsd: charge, drawing, stroke, tries: 0 });
        ch.nudge(-charge);
        sendPiece(ch, signed, stroke, quote.signature, (why) => letGo(key, why));
      }
      bet.charged = charge;
      addChange(-charge, "stake");
      if (!drawing.current.has(line)) drawing.current.set(line, d);
      d.prev = snap;
      d.area = area;
      d.charged = cents(d.charged + charge);
      d.pieces++;
      // The first drawing this browser ever places: where the way in ends and playing starts.
      if (d.pieces === 1) {
        try {
          if (!localStorage.getItem("skech:first-drawing")) {
            localStorage.setItem("skech:first-drawing", "1");
            track("first_drawing", { real: ch.real });
          }
        } catch {}
      }
      if (!g.bets.some(b => !decided(b))) settledTotals.current = { committed: 0, returned: 0 };
      tally(line, bet.placedAt).open++;
      g.bets.push(bet);
      updateTotals();
      if (process.env.NODE_ENV !== "production") (window as unknown as { __lastBet?: unknown }).__lastBet = bet;
      // On chain the hint is all practice keeps: written once, as each write re-rendered everything that reads it.
      if (ch.real) {
        if (!practice().taught) setPractice({ taught: true });
      } else setPractice(st => ({ balance: cents(st.balance - charge), taught: true, open: g.bets.filter(b => !decided(b)) }));
      setLive(new Set(g.bets.filter(b => !decided(b)).map(b => b.group ?? b.id)).size);
      if (done) {
        const tip = stroke.pts.at(-1)!;
        g.fx.push({ kind: "placed", t: stroke.t0 + tip.t, price: stroke.p0 + tip.p, born: performance.now() });
      }
      finish();
      return null;
    },
    [fresh, owner, updateTotals, level, letGo],
  );

  /*
    What the chain says: a piece placed (its bands, as priced there), refused,
    or settled. The ink was drawn as if it would go in; here it is made to
    match what did.
  */
  useEffect(() => {
    if (!real) return;
    const g = game.current;
    const feeBps = () => chainRef.current.hello?.config?.profitFeeBps ?? 1000;
    const off = chain.client.on((m) => {
      if (m.type === "placed") {
        const sent = chainBets.current.get(m.betId);
        if (!sent) return;
        const i = g.bets.findIndex((b) => b.id === sent.id);
        if (i < 0) return;
        const bet = g.bets[i];
        const staked = Number(m.staked) / 1e6;
        // On chain: a soft seal, once per drawing, when its first piece is in.
        const drawn = bet.group ?? bet.id;
        if (!sealed.current.has(drawn)) {
          sealed.current.add(drawn);
          if (sealed.current.size > 200) sealed.current.clear();
          sound.placed();
        }
        const cells = m.sections.map((s) => ({ t: bet.openAt + s.second * 1000, lo: fromE8(BigInt(s.lo)), hi: fromE8(BigInt(s.hi)), area: Number(s.stake) / 1e6 / bet.perUnit, multiple: s.rung / 100, status: "live" as const }));
        g.bets[i] = { ...bet, status: cells.length ? "live" : "void", why: cells.length ? undefined : "The price moved, and none of it is in play now.", cells, charged: staked };
        // What the chain did not take is back.
        if (sent.stakeUsd > staked + 1e-9) {
          chainRef.current.nudge(sent.stakeUsd - staked);
          addChange(cents(sent.stakeUsd - staked), "back");
          setReturnedInk({ id: sent.id, amount: cents(sent.stakeUsd - staked) });
        }
        chainBets.current.set(m.betId, { ...sent, stakeUsd: staked });
        if (!cells.length) {
          chainBets.current.delete(m.betId);
          const line = bet.group ?? bet.id;
          const t = tally(line, bet.placedAt);
          t.open--;
          if (t.open <= 0 && !drawing.current.has(line)) closeLine(line);
        }
        updateTotals();
      } else if (m.type === "account") {
        // Nothing on its way to the chain or waiting on it: the relayer's balance is exact, and the app's own
        // reckoning since is let go. While anything is in flight it is kept, so a stake shows the moment it goes.
        if (chainBets.current.size === 0) chainRef.current.resync();
      } else if (m.type === "refused") {
        letGo(m.betId, m.why);
      } else if (m.type === "settled") {
        // The chain's word on hits and misses, where it differs from what was judged here, or before it was.
        const sent = chainBets.current.get(m.betId);
        if (!sent) return;
        const i = g.bets.findIndex((b) => b.id === sent.id);
        if (i < 0) return;
        const bet = g.bets[i];
        let changed = false;
        let disagreed = 0;
        let takeBack = 0;
        const cells = bet.cells.map((c, k) => {
          const hit = (m.hitMask >> k) & 1;
          const miss = (m.missMask >> k) & 1;
          if (!hit && !miss) return c;
          const status = hit ? ("hit" as const) : ("miss" as const);
          if (c.status === status) return c;
          changed = true;
          if (c.status !== "live") disagreed++;
          // The screen paid a hit the chain calls a miss: take it back, or the balance shows money that is not there.
          if (c.status === "hit" && !hit) takeBack += c.paid ?? 0;
          const stake = bet.perUnit * c.area;
          const gross = stake * c.multiple;
          return { ...c, status, paid: hit ? gross - Math.max(0, gross - stake) * (feeBps() / 10_000) : undefined };
        });
        if (changed) {
          const wasDecided = decided(bet);
          const next: InkBet = { ...bet, cells, status: cells.every((c) => c.status !== "live") ? "done" : "live" };
          g.bets[i] = next;
          // The chain deciding first is normal; the chain deciding otherwise is worth knowing about.
          if (disagreed) track("judge_disagreed", { bands: disagreed });
          if (takeBack > 0) chainRef.current.nudge(-cents(takeBack));
          if (disagreed && process.env.NODE_ENV !== "production") console.warn(`[ink] the chain judged ${disagreed} band${disagreed > 1 ? "s" : ""} of ${bet.id} otherwise: hits ${m.hitMask.toString(2)} misses ${m.missMask.toString(2)}`);
          if (decided(next) && !wasDecided) {
            settledTotals.current.committed += cost(next) - refund(next);
            settledTotals.current.returned += won(next);
            const line = next.group ?? next.id;
            const t = tally(line, next.placedAt);
            t.open--;
            t.won += won(next);
            t.cost += cost(next) - refund(next);
            if (t.open <= 0 && !drawing.current.has(line)) closeLine(line);
          }
          updateTotals();
        }
        if (decided(g.bets[i])) chainBets.current.delete(m.betId);
        chainRef.current.client.send({ type: "account" });
      }
    });
    return () => {
      off();
    };
  }, [real, chain.client, letGo, updateTotals]);

  // For tuning in development: stage a finished round from the console, card, sound, touch and all.
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    (window as unknown as { __round?: unknown }).__round = (won: number, cost = 1, best = 4, streak = 0) => {
      setResult({ key: crypto.randomUUID(), won, cost, hits: won > 0 ? 1 : 0, points: 2, voided: false, best, streak });
      if (won > cost) {
        feel("win", { ratio: won / cost });
        setGained(performance.now());
        addChange(won, "win");
      }
    };
  }, []);
  // For tests in development: place a line from the console, as the pen does.
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") (window as unknown as { __place?: typeof onPlace }).__place = onPlace;
  }, [onPlace]);

  /* A light touch as the ink reaches each new spot; the pen's own scratch comes from the stage. */
  const painted = useRef(0);
  const onPreview = useCallback((p: Preview | null) => {
    preview.set(p);
    setPreviewing(p !== null);
    const n = p?.inPlay.length ?? 0;
    if (!p?.keyboard && n > painted.current) feel("tick");
    painted.current = n;
  }, [preview]);

  const shownBalance = forReal ? chain.balance : state.balance;
  const onboarding = useOnboarding(live);
  /*
    The game plays on for everyone; a tap from someone who cannot play yet opens the way to: Coinbase's sign-in
    signed out, the deposit sheet with less than a dot's worth in the balance. It never reaches the chart, so no
    ink is drawn that could not be placed.
  */
  const cannotPlay: "signin" | "deposit" | null = !forReal || !me.ready ? null : !me.signedIn ? "signin" : real && chain.account !== null && chain.balance < POINT_PRICES.values[0] && live === 0 ? "deposit" : null;
  const onGate = (e: React.PointerEvent) => {
    if (!cannotPlay || owner === false) return;
    // A button or link over the game (a card's action) is not a tap on the game.
    if ((e.target as Element).closest("button, a")) return;
    e.preventDefault();
    e.stopPropagation();
    // Felt and heard, not just a sheet appearing: the short low double note and a double tap under the finger.
    feel("nope");
    if (cannotPlay === "signin") gate.openSignIn("tap");
    else gate.openDeposit("tap");
  };
  /*
    The deposit sheet after running out, only when the game has nothing left to say: no drawing still in play
    (one of them may yet win the balance back), and still not enough for a single dot. A win cancels it.
  */
  useEffect(() => {
    if (!topUp.current || !real || chain.account === null || live > 0) return;
    topUp.current = false;
    if (chain.balance < POINT_PRICES.values[0]) gate.openDeposit("short");
  }, [live, real, chain.account, chain.balance, gate]);
  // No deposit sheet on arrival: the game is there to look at and try first. With nothing to play with, the
  // "Deposit USDC to play" line says so, and a tap on the game (or Deposit) opens the sheet.
  /*
    Until the game can be played the screen says one thing. Signed out: the way in, over the game blurred.
    Signed in: one "Connecting…" until the prices and the account are both here, not one in the header,
    one in a pill and one on the chart.
  */
  const signedOut = onboarding.step === "signin";
  // On a phone's browser, the Home Screen bar sits in the gap over the dock, and the chart gives up a little for it.
  const home = useHomeScreen();
  // Not while signed out: the blur covers it there, and its cross could not be reached.
  const homeBar = home.showing && !signedOut;
  const connecting = !signedOut && (!fresh || onboarding.step === "connecting");
  const [boardOpen, setBoardOpen] = useState(false);
  const board = useScoreboard();
  // The same Skech controls: nib size and the cost of a full dot.
  const controls = (
    <InkControls
      amount={state.perDot}
      className="w-full sm:w-auto"
      onAmount={(n) => {
        if (n !== state.perDot) track("price_changed", { per_dot: n });
        setPractice({ perDot: n });
      }}
      onPen={(id) => {
        if (id !== state.brush) track("pen_changed", { pen: id });
        setPractice({ brush: id });
      }}
      pen={state.brush}
    />
  );

  /**
   * The round just over. A win is celebrated: card, chord, touch. A loss is said once, quietly, in the same
   * place and in muted ink, with no sound or touch, and gets out of the way sooner.
   */
  const over = result && !result.voided && result.cost > 0 ? result : null;
  const overNet = over ? cents(over.won - over.cost) : 0;
  const overWon = overNet > 0;
  const overBig = over ? overWon && (over.won >= over.cost * 3 || (over.best ?? 0) >= 10) : false;
  // What has been won, never what has been lost: this round's payouts while ink is in play, the session's
  // between rounds. The balance beside it is always the exact truth. A tap opens the scoreboard.
  const showingBatch = totals.drawings > 0 || totals.committed > 0;
  const displayedWon = forReal && !real ? 0 : showingBatch ? totals.returned : board.won;

  return (
    <section aria-label="Draw" className={cn(feedback.surface, "relative isolate min-h-0 flex-1 overflow-hidden bg-background")}>
      <div className={feedback.topShade} aria-hidden="true" />
      <div className={feedback.summary}>
        <div className={feedback.market}>
          <Popover>
            <PopoverTrigger render={<Button variant="ghost" aria-label="Change asset: Bitcoin" className={feedback.assetButton} />}>
              <TokenAvatar symbol="BTC" className="size-9 sm:size-10" />
              <span className={feedback.marketName}><span>Bitcoin <ChevronDownIcon className="size-3" strokeWidth={2.4} /></span><strong className="figures"><LivePrice feed={feed} /></strong></span>
            </PopoverTrigger>
            <PopoverPopup align="start" sideOffset={10} className="w-64">
              <PopoverTitle>Choose asset</PopoverTitle>
              <PopoverClose render={<Button variant="ghost" className="mt-3 h-14 w-full justify-start px-2" />} aria-label="Bitcoin, selected">
                <TokenAvatar symbol="BTC" className="size-8" /><span className="flex flex-col items-start"><span>Bitcoin</span><span className="text-xs text-muted-foreground">BTC / USD</span></span><CheckIcon className="ml-auto text-primary" />
              </PopoverClose>
            </PopoverPopup>
          </Popover>
        </div>
        {/* Signed out there is no balance to show, and connecting it is not known yet: $0.00 twice is noise. */}
        {forReal && (!me.ready || !me.signedIn || onboarding.step === "connecting") ? null : (
        <div className={feedback.accounts}>
          {/* The one balance on screen. Playing for real it opens the wallet: deposit, withdraw. */}
          {real ? (
            <WalletButton render={<button aria-label={`Balance ${money(shownBalance)}. Deposit or withdraw`} className={cn(feedback.balance, feedback.tappable)} type="button" />}>
              <span className={feedback.eyebrow}>Balance</span>
              <span className={cn(feedback.balanceValue, "figures", gained ? "text-success-foreground" : "text-foreground")}><CrispNumber value={money(shownBalance)} /></span>
              <Ledger />
            </WalletButton>
          ) : (
            <div className={feedback.balance} aria-label={forReal ? "Balance" : "Practice balance"}>
              <span className={feedback.eyebrow}>Balance</span>
              <span className={cn(feedback.balanceValue, "figures", gained ? "text-success-foreground" : "text-foreground")}><CrispNumber value={money(shownBalance)} /></span>
              <Ledger />
            </div>
          )}
          <div className={feedback.pnlColumn}>
            <button aria-label={`Won ${showingBatch ? "this round" : "this session"}: ${money(displayedWon)}. Open the scoreboard`} className={feedback.pnl} onClick={() => setBoardOpen(true)} type="button">
              <span className={feedback.eyebrow}>Won</span>
              <span className={cn(feedback.pnlValue, "figures", displayedWon > 0 ? "text-success-foreground" : "text-foreground")}>
                <CrispNumber value={displayedWon > 0 ? `+${money(displayedWon)}` : money(0)} />
              </span>
            </button>
          </div>
        </div>
        )}
      </div>

      <div className="absolute inset-0" onPointerDownCapture={onGate} style={homeBar ? { bottom: homeBarRoom(window.innerWidth) } : undefined}>
          {lib ? (
            <HapticHost className="absolute inset-0">
              <Stage onViewport={onViewport} className="absolute inset-0 size-full" game={game} onPlace={onPlace} onPreview={onPreview} />
            </HapticHost>
          ) : null}
          {owner === false ? (
            <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-background/80 backdrop-blur-sm" role="status">
              <p className="text-sm text-muted-foreground">The game is open in another tab.</p>
              <Button onClick={() => takeOver.current?.()}>Play here</Button>
            </div>
          ) : null}
          {connecting && owner !== false ? (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center" role="status">
              <p className="flex items-center gap-2 font-semibold text-[15px] text-muted-foreground"><Spinner className="size-4" /> Connecting…</p>
            </div>
          ) : null}

          {previewing ? (
            <PreviewPill preview={preview} />
          ) : signedOut || connecting ? null : onboarding.step && owner !== false ? (
            <Onboarding {...onboarding} />
          ) : !state.taught && fresh && owner !== false ? (
            <div className={feedback.hintPill}>Draw to the right of the line</div>
          ) : null}

          {/* The round just over: a win celebrated, a big one more so; a loss said once, quietly. */}
          {over && !previewing ? (
            <div className={cn(feedback.roundCard, overWon ? feedback.roundWin : feedback.roundLoss, overBig && feedback.roundBig)} key={over.key} role="status">
              {overWon && (over.streak ?? 0) >= 2 ? <span className={feedback.streak}>{over.streak} wins in a row</span> : null}
              <div>
                <span className={feedback.roundLabel}>{overWon ? (overBig ? "Big win" : "You won") : "Round over"}</span>
                <span className={cn(feedback.roundValue, overWon ? "text-success-foreground" : "text-muted-foreground")}>{signed(overNet)}</span>
                <span className={cn(feedback.roundDetail, "figures")}>
                  {over.points ? `${Math.round((100 * over.hits) / over.points)}% of your ink hit` : ""}
                  {over.best ? ` · best ${fmtMultiple(over.best)}` : ""}
                </span>
              </div>
            </div>
          ) : null}
          {over && overBig && !previewing ? <div aria-hidden="true" className={feedback.glow} key={`glow-${over.key}`} /> : null}
      </div>

      {returnedInk && !previewing && !over ? <div key={returnedInk.id} role="status" className={feedback.bottomPill}>Unpriced ink · <span className="figures font-semibold text-foreground">{money(returnedInk.amount)} refunded</span></div> : null}
      <div className={feedback.bottomShade} aria-hidden="true" />
      {homeBar ? <HomeScreenBar dismiss={home.dismiss} install={home.install} /> : null}
      <UpdateReady busy={live > 0} />
      <HomeScreenSheet open={home.open} setOpen={home.setOpen} where={home.where} />
      <footer className={feedback.toolbar}>
        <Button aria-label="Settings" aria-haspopup="dialog" className={feedback.settingsButton} onClick={() => setSettingsOpen(true)} size="icon" variant="outline"><SlidersHorizontalIcon strokeWidth={1.8} /></Button>
        {controls}
      </footer>

      {/* Signed out: the game plays on behind, blurred, and the only thing to do is sign in. A tap anywhere opens it. */}
      {signedOut && owner !== false ? (
        <div className={cn(feedback.notice, "absolute inset-0 z-30 flex items-center justify-center bg-background/30 backdrop-blur-md")} onClick={() => gate.openSignIn("overlay")}>
          <Button className="h-12 rounded-full px-6 font-semibold text-base sm:h-12">Sign in to play</Button>
        </div>
      ) : null}

      <Sheet onOpenChange={setSettingsOpen} open={settingsOpen}>
        <SheetPopup className="sm:max-w-sm" side="right" variant="inset">
          <SheetHeader className="px-4 pt-6 sm:px-6 sm:pt-8"><SheetTitle className="font-bold text-xl">Settings</SheetTitle><SheetDescription className="sr-only">Sound, haptics, your balance and your drawings</SheetDescription></SheetHeader>
          <SheetPanel className="flex flex-col gap-3.5 px-4 pb-10 sm:px-6">
            <div className="divide-y divide-border overflow-hidden rounded-[14px] bg-muted">
              <ToggleRow checked={state.sound} detail="Pen, hits and round results" onChange={(on) => setPractice({ sound: on })} title="Sounds" />
              <ToggleRow checked={state.haptics} detail="A tap when ink goes in and when it hits" onChange={(on) => setPractice({ haptics: on })} title="Haptics" />
              <ToggleRow checked={dark} detail="Black paper, brighter ink" onChange={setDark} title="Dark mode" />
            </div>
            {forReal ? (
              <div className="flex min-h-[60px] items-center justify-between gap-3 rounded-[14px] bg-muted px-4 py-2"><div className="flex flex-col"><span className="text-[13px] text-muted-foreground">Balance</span><span className="figures font-semibold text-[17px]">{money(chain.balance)}</span></div>{real ? <span className="text-right text-xs text-muted-foreground">Add or withdraw from your balance, top right</span> : <SignInButton />}</div>
            ) : (
              <div className="flex min-h-[60px] items-center justify-between gap-3 rounded-[14px] bg-muted px-4 py-2"><div className="flex flex-col"><span className="text-[13px] text-muted-foreground">Practice balance</span><span className="figures font-semibold text-[17px]">{money(state.balance)}</span></div><DepositButton className="bg-raised" onDeposit={amount => setPractice(st => ({ balance: cents(st.balance + amount) }))} /></div>
            )}
            <div className="divide-y divide-border overflow-hidden rounded-[14px] bg-muted">
              <button className={navRow} onClick={() => { setSettingsOpen(false); setBoardOpen(true); }} type="button">This session<span className={cn("figures ml-auto", board.won > 0 ? "text-success-foreground" : "text-muted-foreground")}>{board.won > 0 ? `+${money(board.won)} won` : ""}</span><ChevronRightIcon className="size-4 text-faint" /></button>
              <button className={cn(navRow, "max-sm:hidden")} onClick={() => void expand()} type="button">{fullscreen ? "Exit full screen" : "Full screen"}<ChevronRightIcon className="ml-auto size-4 text-faint" /></button>
              <button className={navRow} onClick={() => { setSettingsOpen(false); setHelp(true); }} type="button">How it works<ChevronRightIcon className="ml-auto size-4 text-faint" /></button>
            </div>
          </SheetPanel>
        </SheetPopup>
      </Sheet>

      <ScoreboardSheet onOpenChange={setBoardOpen} open={boardOpen} />


      <Sheet onOpenChange={setHelp} open={help}>
        <SheetPopup className="sm:max-w-md" side="right" variant="inset">
          <SheetHeader className="px-6 pt-8">
            <SheetTitle className="font-bold text-xl">How it works</SheetTitle>
            <SheetDescription>{forReal ? "Real money, on the live Bitcoin price." : "Practice money, on the live Bitcoin price."}</SheetDescription>
          </SheetHeader>
          <SheetPanel className="flex flex-col gap-4 px-6 pb-8 text-sm leading-relaxed">
            <p>Draw ahead of the live price. One full dot at your selected pen size costs the amount under Per dot. A longer stroke costs more; retracing ink in the same drawing adds no cost. The total cost rounds up to the next cent, once per drawing.</p>
            <p>Every part of your ink pays a rung of the ladder on the map, 1.1× up to 128× what it cost, if the price crosses it in its second. Rungs come from the chance the price reaches that spot then: near the price and soon is likely and pays little; far away pays a lot. A wider pen puts more ink, and more money, on the same spots; it never changes what a spot pays. Only solid blue ink is in play. A hit pays immediately.</p>
            <p>Ink is bet as you draw it, not when you lift the pen: each new bit opens on the next second at the price for that moment, so a slow stroke is not priced on where the market has gone by the time you finish. Going back over your own ink costs nothing. The drawing’s cost rounds up to the cent once, over all of it.</p>
            <p>Placing a drawing takes its stake from your balance straight away; what just moved your balance shows under it. The number beside it is what you have won: this round&rsquo;s payouts while ink is in play, this session&rsquo;s otherwise. Tap it for the scoreboard. Hits pay the moment the price touches them; the rest settles when its second closes.</p>
            <p>Ink starts counting one to two seconds ahead: everything right of the dashed wait line always counts, and it reaches {RULES.horizon} seconds ahead.</p>
            <p className="text-muted-foreground">Odds use historical Bitcoin paths, price distance, time, volatility and momentum. Every part pays a rung of one ladder, 1.1× to 128×, set by its chance: ink exactly on a rung returns {Math.round(difficulty(level).ladderBest * 100)}¢ per dollar, and everywhere else rounds down to the rung below, a little less on the side the price is moving towards. Nothing pays under {difficulty(level).ladderFloor}×. This is not a guaranteed return. Hits are resolved using one-second price ranges. {forReal ? `${feesLine(chain.hello?.config)} Wins are paid from what other players lose; if that runs short, the rest is owed to you and paid as it refills.` : "Your balance is practice money saved in this browser."}</p>
            {house && !forReal ? (
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
