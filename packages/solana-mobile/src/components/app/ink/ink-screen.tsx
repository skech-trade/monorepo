import { sha256 } from "@noble/hashes/sha256";
import { BlurTargetView, BlurView } from "expo-blur";
import { LinearGradient } from "expo-linear-gradient";
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, SlidersHorizontalIcon } from "@/components/ui/icons";
import { useCallback, useEffect, useRef, useState } from "react";
import { BURST, type Tier, winTier } from "@skech/core/cheer";
import { AppState, Platform, Pressable, Text, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { DIFFICULTY, difficulty, features, type Field, type Library, openFor, RULES, setDifficulty, stepFor } from "@skech/core/dots";
import { canDraw, levelFor, PAPER_PER_DOT, paperResult } from "@skech/core/paper";
import { areaCells, areaCostOf, cost, decided, drawingLayout, INK_CELL, INK_EDGE_CELLS, type InkBet, isArea, judge, liveInkTotals, open, openOn, placeInk, refund, type Stroke, won } from "@skech/core/ink";
import { roundedTerms as areaTerms } from "@skech/core/odds";
import { cutAt, encodeStroke, fromE8, gridStep, LATE_MS, stakeOf, toE6, toE8, toSections, unitFor, usdE6 } from "@skech/core/chain";
import { pieceBytes, type SolanaPiece } from "@skech/contracts/solana/sdk";
import { useAccount } from "@/components/app/auth";
import { useGate } from "@/components/app/gate";
import { BitcoinMark, Button, Popover, raised, Sheet, Spinner, Switch, useColors } from "@/components/ui";
import { hasAuth } from "@/lib/config";
import { useAppActive } from "@/lib/lifecycle";
import { useEngine } from "@/lib/engine";
import { track } from "@/lib/analytics";
import { celebrate, feel } from "@/lib/feel";
import { FieldMaker } from "@/lib/field";
import { library } from "@/lib/library";
import { money, signed } from "@/lib/money";
import { endPaperRun, paper, paperCredit, paperDebit, paperDrew, paperTick, pausePaperRun, resumePaperRun, startPaperRun, usePaper, usePaperPhase } from "@/lib/paper";
import { cents, practice, record, setPractice, usePractice } from "@/lib/practice";
import { type Incoming, leastPiece } from "@/lib/relayer";
import { scoreboard, useScoreboard } from "@/lib/scoreboard";
import { setDark, useDark } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { type Chain, useChain } from "./chain-context";
import { DepositButton, InkControls } from "./ink-controls";
import { introReady } from "./ink-intro";
import { addChange, Ledger } from "./ledger";
import { Arrive, Bump, Confetti, type ConfettiHandle, Glow, MOTION, ProfitGlow, RisingMoney } from "./motion";
import { Onboarding, Pill, useOnboarding } from "./onboarding";
import { type Game, type Placed, type Preview, Stage } from "./stage";
import { WalletButton } from "./wallet-button";
import { publishStroke } from "@/lib/social";

/** How old a map of multiples may be, in ms past its second, and still be shown. */
const STALE_MAP_MS = 3500;

/**
 * skech. Predict where Bitcoin goes next by drawing it on the chart; wherever the price runs through your ink pays.
 *
 * The web's game screen (ui/app/src/components/app/ink/ink-screen.tsx), rule for rule, on the phone and on
 * Solana. The rules are `@skech/core`, the same code the relayer and the chain run. This screen keeps the
 * practice money, prices the map, opens each drawing on its second, and judges every second's trades as they
 * arrive; playing for real, each piece of ink is signed by the session key and placed through the relayer.
 */

const OPEN_AFTER_MS = 350;
const OPEN_BY_MS = 900;
const CLOSE_AFTER_MS = 600;
const CHAIN_ANSWER_MS = 8000;
/** The chain's name for a drawing: 64 bits of the line's id. */
// A sha256 in JavaScript for every piece on every price batch was a thousand hashes a second: each line's is kept.
const drawingIds = new Map<string, bigint>();
const drawingIdOf = (line: string) => {
  let id = drawingIds.get(line);
  if (id === undefined) {
    const h = sha256(new TextEncoder().encode(line));
    id = new DataView(h.buffer, h.byteOffset).getBigUint64(0, true);
    if (drawingIds.size > 2000) drawingIds.clear();
    drawingIds.set(line, id);
  }
  return id;
};
/** The first bar at or after `t`, by halving: bars are a second apart and in order. */
const firstBarFrom = (bars: { t: number }[], t: number) => {
  let lo = 0,
    hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};
/** Whether this build plays for real money: a way to sign in. Without one it plays for practice, as the web does without a game. */
const forReal = hasAuth || Platform.OS === "android";
const pieceIndexOf = (id: string) => Number(id.slice(id.lastIndexOf(":") + 1));
/** A piece's key while it is on its way: its drawing and number, as the relayer names it back. */
const keyOf = (drawing: bigint | string, index: number) => `${drawing}:${index}`;
const hexOf = (b: Uint8Array) => `0x${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`;
const bytesOf = (h: string) => Uint8Array.from((h.replace(/^0x/, "").match(/../g) ?? []).map((x) => parseInt(x, 16)));

/** The dots a line as it stood covers on an opening: once per mark and second, as held ink is asked at every read. */
const areas = new WeakMap<Stroke, { at: number; step: number; area: number }>();
const inkArea = (st: Stroke, at: number, step: number) => {
  const c = areas.get(st);
  if (c && c.at === at && c.step === step) return c.area;
  const area = areaCells(st, at, step).reduce((n, x) => n + x.area, 0);
  areas.set(st, { at, step, area });
  return area;
};
/** Reads of a line kept while its ink is held back: a cut can only be at one of them. */
const MARKS = 32;

type SentPiece = { id: string; stakeUsd: number; drawing: bigint; stroke: Uint8Array; tries: number };
const RESEND = /^(Too late for that second|Price seen is stale|Difficulty|Waiting for live prices|Starting up|No price to open on|Late$|StalePrice$)/;
const RESENDS = 2;
const RESEND_BASE = 100_000;

/** A piece as the session key signs it, and as it goes on the wire: bands in grid units, the chain's numbers as strings. */
function pieceFor(ch: Chain, level: number, drawing: bigint, index: number, openAt: number, perDot: number, unit: number, quote: { price: string | number; time: string | number }, sections: ReturnType<typeof toSections>, stroke: Uint8Array) {
  const unitE8 = toE8(unit);
  const piece: SolanaPiece = {
    domain: bytesOf(ch.hello!.domain),
    player: ch.player! as SolanaPiece["player"],
    drawing,
    index,
    market: ch.hello!.market.id,
    difficulty: ch.hello!.difficulty ?? level,
    openAt: BigInt(openAt),
    perDot: Number(toE6(perDot)),
    unit: unitE8,
    priceSeen: BigInt(quote.price),
    priceTime: BigInt(quote.time),
    strokeHash: sha256(stroke),
    sections: sections.map((s) => ({ second: s.second, lo: Number(s.lo / unitE8), width: Number((s.hi - s.lo) / unitE8), stake: Number(s.stake) })),
  };
  const wire = { ...piece, domain: undefined, drawing: drawing.toString(), openAt: String(openAt), unit: unitE8.toString(), priceSeen: piece.priceSeen.toString(), priceTime: piece.priceTime.toString(), strokeHash: hexOf(piece.strokeHash as Uint8Array) };
  return { piece, wire };
}
function sendPiece(ch: Chain, { piece, wire }: ReturnType<typeof pieceFor>, stroke: Uint8Array, priceSig: string, fail: (why: string) => void) {
  const key = ch.key!;
  void (async () => {
    try {
      const sig = key.sign(pieceBytes(piece));
      console.info(`[ink] sending piece ${wire.drawing}:${piece.index}: opens ${piece.openAt}, ${piece.sections.length} sections, ${piece.perDot} per dot`);
      const ack = await ch.client.request({ type: "piece", piece: wire, sessionSig: hexOf(sig), priceSig, stroke: hexOf(stroke) }, (m): m is Extract<Incoming, { type: "ack" }> => m.type === "ack" && m.drawing === wire.drawing && m.index === piece.index, 10_000);
      if (!ack || !ack.ok) fail(ack?.why ?? "No answer. Your money is back.");
      // Taken: the same bytes the relayer got, to the community, so other players see the line (the chain keeps its hash).
      else if (ack.betId) publishStroke(ack.betId, hexOf(stroke));
    } catch (e) {
      fail(String((e as Error).message ?? e));
    }
  })();
}
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

/** A price with its cents quieter than its dollars. */
function Price({ value, className }: { value: number; className?: string }) {
  const [whole, part] = money(value).split(".");
  return (
    <Text className={className} style={{ fontVariant: ["tabular-nums"] }}>
      {whole}
      <Text className="text-faint">.{part}</Text>
    </Text>
  );
}

function ToggleRow({ title, detail, checked, onChange }: { title: string; detail: string; checked: boolean; onChange: (next: boolean) => void }) {
  return (
    <View className="min-h-[60px] flex-row items-center gap-3 px-4">
      <View className="flex-1">
        <Text className="text-[17px] text-foreground">{title}</Text>
        <Text className="text-[13px] text-muted-foreground">{detail}</Text>
      </View>
      <Switch checked={checked} onChange={onChange} />
    </View>
  );
}

/** A row that leads somewhere; a destructive one, red and without the chevron, does something instead. */
function NavRow({ children, trailing, onPress, destructive }: { children: string; trailing?: React.ReactNode; onPress: () => void; destructive?: boolean }) {
  const c = useColors();
  return (
    <Pressable accessibilityRole="button" className="min-h-[52px] flex-row items-center gap-3 px-4" onPress={onPress} style={({ pressed }) => ({ backgroundColor: pressed ? "rgba(127,127,127,0.12)" : "transparent" })}>
      <Text className={cn("flex-1 text-[17px]", destructive ? "text-destructive-foreground" : "text-foreground")}>{children}</Text>
      {trailing}
      {destructive ? null : <ChevronRightIcon color={c.faint} size={16} />}
    </Pressable>
  );
}

/** The paper run's money, where the balance would be: "Paper money", never "Balance". */
function PaperMoney({ gained }: { gained: boolean }) {
  const run = usePaper();
  if (!run) return null;
  return (
    <View className="flex-row items-center gap-[14px]">
      <View accessibilityLabel={`Paper money ${money(run.balance)}, not real`} className="items-end">
        <Text className="text-[12px] text-muted-foreground">Paper money</Text>
        <Bump on={gained}>
          <RisingMoney className={cn("font-semibold text-[16px]", gained ? "text-success-foreground" : "text-foreground")} style={{ fontVariant: ["tabular-nums"] }} value={run.balance} />
        </Bump>
        <Ledger />
      </View>
      <View className="items-end">
        <Text className="text-[12px] text-muted-foreground">Earned</Text>
        <Text className={cn("font-semibold text-[16px]", run.won > 0 ? "text-success-foreground" : "text-foreground")} style={{ fontVariant: ["tabular-nums"] }}>
          {run.won > 0 ? `+${money(run.won)}` : money(0)}
        </Text>
      </View>
    </View>
  );
}

/** The paper run's clock, at the stroke pill's place, always on screen while it runs, and urgent in its last seconds; the web's `PaperClock`. */
function PaperClock({ top }: { top: number }) {
  const run = usePaper();
  if (!run || run.phase === "over") return null;
  return (
    <View className="absolute inset-x-0 z-20 items-center" pointerEvents="none" style={{ top }}>
      <Arrive motion={MOTION.pillIn}>
        <View className={cn("flex-row gap-1.5 rounded-full border-[0.5px] bg-raised px-4 py-2", run.urgent ? "border-destructive-foreground" : "border-border")} style={raised}>
          <Text className={cn("min-w-[30px] font-semibold text-[13px]", run.urgent ? "text-destructive-foreground" : "text-foreground")} style={{ fontVariant: ["tabular-nums"] }}>
            {run.clock}
          </Text>
          <Text className={cn("text-[13px]", run.urgent ? "text-destructive-foreground" : "text-muted-foreground")}>· Practice</Text>
        </View>
      </Arrive>
    </View>
  );
}

/** The end of a paper run: what it came to, and the two ways on, on the way-in card (onboarding.tsx). */
function PaperEnd({ onSignIn, onAgain, blurTarget }: { onSignIn: () => void; onAgain: () => void; blurTarget: React.RefObject<View | null> }) {
  const run = usePaper();
  const dark = useDark();
  if (!run || run.phase !== "over") return null;
  const { headline } = paperResult(run, money);
  return (
    <View accessibilityLabel="Your practice run" className="absolute inset-0 z-30 items-center justify-center px-4">
      <BlurView blurTarget={blurTarget} experimentalBlurMethod="dimezisBlurView" intensity={60} style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0 }} tint={dark ? "dark" : "light"} />
      <Arrive motion={MOTION.cardIn} style={{ width: "100%", alignItems: "center" }}>
        <View className="w-full max-w-[360px] rounded-[28px] bg-raised p-6" style={raised}>
          <Text className="font-semibold text-[22px] text-foreground">{headline}</Text>
          <Text className="mt-1.5 text-[15px] text-muted-foreground">Practice money on the live Bitcoin price.</Text>
          <Button className="mt-5" onPress={onSignIn}>
            Sign in to play for real
          </Button>
          <Button className="mt-2 border border-border" onPress={onAgain} variant="secondary">
            Try again
          </Button>
        </View>
      </Arrive>
    </View>
  );
}

export function InkScreen() {
  const feed = useEngine();
  const active = useAppActive();
  const feedRef = useRef(feed);
  useEffect(() => {
    feedRef.current = feed;
  });
  const state = usePractice();
  const chain = useChain();
  const chainRef = useRef(chain);
  useEffect(() => {
    chainRef.current = chain;
  });
  const real = chain.real;
  const chainBets = useRef(new Map<string, SentPiece>());
  /** The chain's name for a bet (its account), once placed, to the piece's key: settlements name it that way. */
  const betKeys = useRef(new Map<string, string>());
  const resent = useRef(0);
  const [lib, setLib] = useState<Library | null>(null);
  const maker = useRef<FieldMaker | null>(null);
  const requestId = useRef(0);
  useEffect(() => {
    let live = true;
    void library().then(
      ({ lib: l }) => {
        if (!live) return;
        setLib(l);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);

  const [preview, setPreview] = useState<Preview | null>(null);
  const [help, setHelp] = useState(false);
  const [returnedInk, setReturnedInk] = useState<{ id: string; amount: number } | null>(null);
  useEffect(() => {
    if (!returnedInk) return;
    const timer = setTimeout(() => setReturnedInk(null), 3200);
    return () => clearTimeout(timer);
  }, [returnedInk]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const blurTarget = useRef<View>(null);
  const dark = useDark();
  /*
    A paper run: "Try it free", signed out, on paper money held only in memory (lib/paper.ts). Its ink is priced,
    judged and paid here, as practice is, and never goes near the relayer: it can only be drawn signed out, where
    there is no session to send it with, and signing in throws it away.
  */
  const paperPhase = usePaperPhase();
  const paperOn = paperPhase !== null && !real;
  // On chain, the game's; on a paper run, its own easier one; else the house's or the game's own. Only paper goes under 50.
  const { level, least } = levelFor({ paper: paperOn, chain: real || paperOn ? (chain.hello?.difficulty ?? null) : null, house: state.houseDifficulty });
  const [live, setLive] = useState(0);
  const [result, setResult] = useState<{ key: string; won: number; cost: number; hits: number; points: number; voided: boolean; best?: number; streak?: number } | null>(null);
  useEffect(() => {
    if (!result) return;
    const t = setTimeout(() => setResult(null), result.won > result.cost ? 4200 : 2400);
    return () => clearTimeout(t);
  }, [result]);
  const [fresh, setFresh] = useState(false);
  const me = useAccount();
  // The way in holds its ink over the screen until there are live prices to show, and it is known who is playing.
  useEffect(() => {
    if (fresh && me.ready) introReady();
  }, [fresh, me.ready]);
  const [gained, setGained] = useState<number>(0);
  useEffect(() => {
    if (!gained) return;
    const t = setTimeout(() => setGained(0), 1400);
    return () => clearTimeout(t);
  }, [gained]);
  const hitRun = useRef({ n: 0, at: 0 });
  /*
    A profitable round's celebration on the screen, besides its card: the balance lights up, a strong one lights the
    edges, and confetti flies from where the price met the ink. `key` plays it again for the next. Profitable rounds
    in a row on paper, which keeps no books.
  */
  const [cheer, setCheer] = useState<{ key: string; tier: Tier } | null>(null);
  useEffect(() => {
    if (!cheer) return;
    const t = setTimeout(() => setCheer(null), 2600);
    return () => clearTimeout(t);
  }, [cheer]);
  const paperRun = useRef(0);
  /** Where the price last met each line's ink, for its confetti. */
  const lastHit = useRef(new Map<string, { t: number; price: number; at: number }>());
  const confetti = useRef<ConfettiHandle>(null);
  const sealed = useRef(new Set<string>());
  const insets = useSafeAreaInsets();
  const top = insets.top + 64;
  const bottom = Math.max(22, insets.bottom);
  const game = useRef<Game>({ bars: [], ticks: [], skew: 0, field: null, placeLead: 0, step: 1, priceStep: 1, marketStep: 1, viewport: { width: 390, height: 800 }, displayPrice: 0, perDot: state.perDot, pen: state.brush, cell: INK_CELL, bets: [], quote: null, fx: [], dark: false });
  // The stage finds where a profitable round's confetti starts; the confetti's own canvas throws it.
  useEffect(() => {
    game.current.burst = (x, y, tier) => confetti.current?.fire(x, y, BURST[tier as Tier], tier);
  }, []);
  useEffect(() => {
    game.current.dark = dark;
  }, [dark]);

  const onViewport = useCallback((size: { width: number; height: number }) => {
    game.current.viewport = size;
  }, []);
  const settledTotals = useRef({ committed: 0, returned: 0 });
  const [totals, setTotals] = useState(() => liveInkTotals([]));
  const updateTotals = useCallback(() => {
    const next = liveInkTotals(game.current.bets, settledTotals.current);
    setTotals((previous) => (previous.committed === next.committed && previous.returned === next.returned && previous.settledCost === next.settledCost && previous.drawings === next.drawings ? previous : next));
  }, []);

  useEffect(() => {
    game.current.placeLead = real ? LATE_MS : 0;
  }, [real]);

  useEffect(() => {
    const g = game.current;
    // A paper run's price is its own, fixed for the run; the player's own pick waits for real play.
    g.perDot = paperOn ? PAPER_PER_DOT : state.perDot;
    setDifficulty(level, least);
    if (g.field && g.field.rtp !== difficulty(level, least).rtp) g.field = null;
    g.pen = state.brush;
    g.cell = INK_CELL;
  }, [state.perDot, state.brush, state.taught, level, least, paperOn]);

  /*
    Every tenth of a second: whether the prices are fresh, and the map for a drawing placed now, made a slice a
    frame by the FieldMaker (the web's worker). The dot size follows the market, only while nothing is drawn.
  */
  const connected = feed.connected && lib !== null;
  useEffect(() => {
    // In the background no map is made: the phone would spend its battery on odds nobody sees. Back, it starts afresh.
    if (!lib || !active) {
      if (!active) {
        game.current.field = null;
        setFresh(false);
      }
      return;
    }
    let asked = "";
    let pendingId = 0;
    let lastFeatures: { key: string; f: ReturnType<typeof features> } = { key: "", f: null as unknown as ReturnType<typeof features> };
    // The newest map shown: the maker finishes a map before starting the next, so one a second or two behind still
    // comes in, and is better than none on a slow phone.
    let shown = 0;
    const m = new FieldMaker(lib, (id, fl) => {
      if (id <= shown) return;
      shown = id;
      const g = game.current;
      if (Date.now() + g.skew - fl.openAt > STALE_MAP_MS) {
        asked = "";
        return;
      }
      if (Math.abs(fl.step - g.priceStep * g.cell) > 1e-9 || fl.rtp !== difficulty(level, least).rtp || fl.edgeCells !== INK_EDGE_CELLS) return;
      g.field = fl;
    });
    maker.current = m;
    const tick = () => {
      const g = game.current;
      const latest = g.bars.at(-1);
      const nowMs = Date.now() + g.skew;
      const last = g.ticks.at(-1)?.t ?? latest?.t ?? 0;
      const ok = connected && !!latest && nowMs - last < 5000 && g.bars.length > 60;
      setFresh(ok);
      if (!ok) {
        g.field = null;
        return;
      }
      const at = Math.floor((nowMs - OPEN_AFTER_MS) / 1000) * 1000;
      // The market's features, once a second rather than every 100ms tick: only the second's map uses them.
      const featureKey = `${at}:${g.bars.at(-1)?.t}`;
      if (featureKey !== lastFeatures.key) lastFeatures = { key: featureKey, f: features(g.bars, at) };
      const f = lastFeatures.f;
      if (!f) return;
      const want = stepFor(f.sigma, f.price);
      if (!g.drawing) {
        if (g.field === null || Math.abs(Math.log(want / g.marketStep)) > Math.log(1.6)) g.marketStep = want;
        g.step = drawingLayout(g.viewport.width, g.viewport.height, g.marketStep).step;
        g.priceStep = gridStep(g.marketStep);
      }
      const size = g.priceStep * g.cell;
      const key = `${at}:${size}:${level}`;
      if (key !== asked) {
        asked = key;
        pendingId = ++requestId.current;
        m.ask({ id: pendingId, f, at, step: size, cell: g.cell, difficulty: level, least });
      }
    };
    tick();
    const timer = setInterval(tick, 100);
    game.current.quote = (st: Stroke) => {
      const g = game.current;
      if (!g.field) return null;
      const l = areaTerms(g.field, Date.now() + g.skew + g.placeLead, g.drawing?.priceStep ?? g.priceStep, g.drawing?.perDot ?? g.perDot).line(st);
      return { multipleLow: l.multipleLow, multipleHigh: l.multipleHigh, cost: l.cost, low: l.low, high: l.high, units: l.units, inPlay: l.inPlay, out: l.out };
    };
    return () => {
      clearInterval(timer);
      m.stop();
      maker.current = null;
    };
  }, [connected, lib, level, least, active]);

  const lines = useRef(new Map<string, { at: number; open: number; won: number; cost: number; hits: number; points: number; best: number }>());
  /** Drawings under the pen: what has gone in so far, and on chain the line at each read since, while its ink is held back. */
  const drawing = useRef(new Map<string, { prev: Stroke | null; area: number; charged: number; at: number; pieces: number; marks: Stroke[] }>());
  const payouts = useRef(new Map<string, { raw: number; credited: number }>());
  const tally = (line: string, at: number) => {
    let t = lines.current.get(line);
    if (!t) lines.current.set(line, (t = { at, open: 0, won: 0, cost: 0, hits: 0, points: 0, best: 0 }));
    return t;
  };
  const closeLine = (line: string) => {
    const t = lines.current.get(line);
    if (!t || t.open > 0 || drawing.current.has(line)) return;
    lines.current.delete(line);
    const paidOut = payouts.current.get(line);
    payouts.current.delete(line);
    if (paidOut) t.won = paidOut.credited;
    if (!t.points) return setResult({ key: line, won: 0, cost: 0, hits: 0, points: 0, voided: true });
    // Paper rounds stay out of the session's books: those are the player's own.
    const onPaper = paper() !== null && !chainRef.current.real;
    if (!onPaper) record({ id: line, at: t.at, cost: cents(t.cost), won: cents(t.won), hits: t.hits, dots: t.points, best: t.best });
    // Only a round that came out ahead is celebrated, by how much it made; a loss, or breaking even, passes in silence.
    const tier = winTier(cents(t.won), cents(t.cost), t.best);
    if (onPaper) paperRun.current = tier ? paperRun.current + 1 : 0;
    const streak = onPaper ? paperRun.current : scoreboard().streak;
    setResult({ key: line, won: cents(t.won), cost: cents(t.cost), hits: t.hits, points: t.points, voided: false, best: t.best, streak });
    const hit = lastHit.current.get(line);
    lastHit.current.delete(line);
    if (tier) {
      celebrate(tier, Math.max(1, streak));
      setCheer({ key: line, tier });
      // From where the price last met the ink, if that is still on the chart.
      if (hit && performance.now() - hit.at < 20_000) game.current.fx.push({ kind: "burst", t: hit.t, price: hit.price, born: performance.now(), tier });
    } else if (!t.hits) hitRun.current.n = 0;
  };
  const gate = useGate();
  const topUp = useRef(false);
  const letGoRef = useRef<(key: string, why: string) => void>(() => {});
  const resend = useCallback(
    (key: string, why: string): boolean => {
      const g = game.current;
      const ch = chainRef.current;
      const sent = chainBets.current.get(key);
      const quote = feedRef.current.quote;
      if (!sent || sent.tries >= RESENDS || !RESEND.test(why)) return false;
      if (!quote?.message || !quote.signature || !ch.hello || !ch.player || !ch.key || !ch.sessionOk) return false;
      const i = g.bets.findIndex((b) => b.id === sent.id);
      if (i < 0 || g.bets[i].status !== "opening") return false;
      const bet = g.bets[i];
      const line = bet.group ?? bet.id;
      const openAt = openFor(Date.now() + g.skew + g.placeLead);
      const drawn = bet.drawn.filter((c) => c.t >= openAt + 1000);
      const unit = bet.step * (bet.cell ?? INK_CELL);
      const sections = toSections(drawn, openAt, toE6(bet.perUnit), unit);
      // What is still ahead of the price must make a piece by itself: under the least, the ink is let go.
      if (!sections.length || stakeOf(sections) < leastPiece(ch.hello)) return false;
      const stakeUsd = Number(stakeOf(sections)) / 1e6;
      const index = RESEND_BASE + resent.current++;
      const next = keyOf(sent.drawing, index);
      const signedPiece = pieceFor(ch, level, sent.drawing, index, openAt, bet.perUnit, unit, quote.message, sections, sent.stroke);
      chainBets.current.delete(key);
      chainBets.current.set(next, { ...sent, id: `${line}:${index}`, stakeUsd, tries: sent.tries + 1 });
      ch.nudge(sent.stakeUsd - stakeUsd);
      const back = cents(sent.stakeUsd - stakeUsd);
      if (back > 0) addChange(back, "back");
      g.bets[i] = { ...bet, id: `${line}:${index}`, openAt, drawn, charged: stakeUsd };
      sendPiece(ch, signedPiece, sent.stroke, quote.signature, (w) => letGoRef.current(next, w));
      updateTotals();
      return true;
    },
    [level, updateTotals],
  );
  const letGo = useCallback(
    (key: string, why: string) => {
      const g = game.current;
      if (resend(key, why)) return;
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
      console.warn(`[ink] piece ${sent.id} not placed: ${why}`);
    },
    [updateTotals, resend],
  );
  useEffect(() => {
    letGoRef.current = letGo;
  }, [letGo]);

  const restored = useRef(false);
  const { bars, ticks, skew, version } = feed;
  useEffect(() => {
    const g = game.current;
    g.bars = bars;
    g.ticks = ticks;
    g.skew = skew;
    g.displayPrice = ticks.at(-1)?.p ?? bars.at(-1)?.c ?? 0;
    const latest = bars.at(-1);
    if (!latest || !lib) return;
    const nowMs = Date.now() + skew;
    let credit = 0;
    /** What of `credit` hits paid, for a paper run's "Earned". */
    let paidOut = 0;
    if (!restored.current && bars.length > 300) {
      restored.current = true;
      const firstBar = bars[0].t + 5000;
      for (const bet of chainRef.current.real ? [] : practice().open) {
        if (bet.openAt >= firstBar) {
          g.bets.push(bet);
          if (!decided(bet)) tally(bet.group ?? bet.id, bet.placedAt).open++;
          continue;
        }
        credit += bet.status === "opening" ? cost(bet) : bet.perUnit * bet.cells.filter((s) => s.status === "live").reduce((a, s) => a + s.area, 0);
      }
    }
    let changed = false;
    for (let i = 0; i < g.bets.length; i++) {
      let bet = g.bets[i];
      const key = chainRef.current.real ? keyOf(drawingIdOf(bet.group ?? bet.id), pieceIndexOf(bet.id)) : "";
      const onChain = chainRef.current.real ? chainBets.current.has(key) : false;
      if (bet.status === "opening" && onChain) {
        if (nowMs >= bet.openAt + CHAIN_ANSWER_MS) {
          const sent = chainBets.current.get(key);
          chainBets.current.delete(key);
          if (sent) {
            chainRef.current.nudge(sent.stakeUsd);
            addChange(sent.stakeUsd, "back");
          }
          bet = { ...bet, status: "void", why: "No answer. Your money is back." };
          changed = true;
        }
      } else if (bet.status === "opening" && nowMs >= bet.openAt + OPEN_AFTER_MS) {
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
        let from = Infinity;
        for (const d of bet.cells) if (d.status === "live" && d.t < from) from = d.t;
        for (let k = firstBarFrom(bars, from); k < bars.length; k++) {
          const bar = bars[k];
          if (bar.t < from) continue;
          const before = bet;
          const prev = k > 0 && bars[k - 1].t === bar.t - 1000 ? bars[k - 1].c : undefined;
          bet = judge(bet, bar, bar.t + 1000 + CLOSE_AFTER_MS <= nowMs, prev);
          if (bet === before) continue;
          if (chainRef.current.real) bet = lessProfitFee(bet, before, chainRef.current.hello?.terms?.profitFeeBps ?? 1000);
          changed = true;
          const hitNow = bet.cells.filter((d, kk) => d.status === "hit" && before.cells[kk].status !== "hit");
          if (hitNow.length) {
            const line = bet.group ?? bet.id;
            const acc = payouts.current.get(line) ?? { raw: 0, credited: 0 };
            payouts.current.set(line, acc);
            acc.raw += won(bet) - won(before);
            const due = Math.max(0, Math.floor(acc.raw * 100 + 1e-8) / 100 - acc.credited);
            acc.credited = cents(acc.credited + due);
            credit += due;
            paidOut += due;
            const paid = Math.floor((won(bet) - won(before)) * 100 + 1e-8) / 100;
            const best = Math.max(...hitNow.map((d) => d.multiple * (isArea(bet.model) ? d.area : 1)));
            const lo = Math.min(...hitNow.map((d) => d.lo));
            const hi = Math.max(...hitNow.map((d) => d.hi));
            const recent = nowMs - (bar.t + 1000) < 3000;
            // A hit is celebrated (heard, felt, a spray) only while its round is ahead: what it has paid so far is more
            // than everything it has staked. A hit that still leaves the round behind is shown, quietly, and no more.
            let stake = lines.current.get(line)?.cost ?? 0;
            for (let j = 0; j < g.bets.length; j++) {
              const b = j === i ? bet : g.bets[j];
              if ((b.group ?? b.id) === line && !decided(g.bets[j])) stake += cost(b) - refund(b);
            }
            const ahead = acc.credited - stake > 0.005;
            const where = { t: hitNow[0].t + 500, price: Math.min(hi, Math.max(lo, bar.c)) };
            if (recent) {
              g.fx.push({ kind: "hit", ...where, born: performance.now(), text: paid > 0 ? `+${money(paid)}` : undefined, line, big: best >= 10, profit: ahead });
              lastHit.current.set(line, { ...where, at: performance.now() });
            }
            if (recent && ahead) {
              const run = hitRun.current;
              run.n = performance.now() - run.at < 6000 ? run.n + 1 : 0;
              run.at = performance.now();
              feel(best >= 10 ? "big" : run.n >= 2 ? "run" : "hit", { multiple: best, run: run.n });
            }
          }
          // Ink the price passed by: what it staked, shown as lost there, in red, as a hit shows what it paid.
          const missNow = bet.cells.filter((d, kk) => d.status === "miss" && before.cells[kk].status !== "miss");
          if (missNow.length && nowMs - (bar.t + 1000) < 3000) {
            // One small red amount per dot, at that dot: what it cost. At most 8 a second, so a long miss stays readable.
            for (const d of missNow.slice(0, 8)) {
              const lost = Math.floor(bet.perUnit * (isArea(bet.model) ? d.area : 1) * 100 + 1e-8) / 100;
              if (lost > 0) g.fx.push({ kind: "miss", t: d.t + 500, price: (d.lo + d.hi) / 2, born: performance.now(), text: `\u2212${money(lost)}`, loss: true, line: bet.group ?? bet.id });
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
    // Paper ink exists only while signed out with a run on (it is thrown away at sign-in), so its money goes back to the run.
    const onPaper = paper() !== null && !chainRef.current.real;
    if (credit) {
      if (chainRef.current.real) chainRef.current.nudge(credit);
      else if (onPaper) paperCredit(credit, paidOut);
      else setPractice((s) => ({ balance: cents(s.balance + credit) }));
    }
    if (credit > 0) {
      setGained(performance.now());
      addChange(cents(credit), "win");
    }
    // Practice drawings are kept for the next launch; paper ones are not, and must never come back as practice.
    if ((changed || credit) && !chainRef.current.real && !onPaper) setPractice({ open: g.bets.filter((b) => !decided(b)) });
    setLive(new Set(g.bets.filter((b) => !decided(b)).map((b) => b.group ?? b.id)).size);
    g.bets = g.bets.filter((b) => !decided(b) || b.cells.some((d) => d.t + 3000 > nowMs));
    updateTotals();
  }, [bars, ticks, skew, version, lib, updateTotals]);

  /* Ink goes in as it is drawn: every few moments while the pen is down, the ink added since the last piece opens on the next second. */
  const onPlace = useCallback(
    (stroke: Stroke, line: string, done: boolean): Placed => {
      const g = game.current;
      if (!fresh || !g.field) return "Waiting for live prices";
      const d = drawing.current.get(line) ?? { prev: null, area: 0, charged: 0, at: 0, pieces: 0, marks: [] };
      const finish = () => {
        if (!done) return;
        drawing.current.delete(line);
        closeLine(line);
      };
      const ch = chainRef.current;
      // A paper run takes ink only while its clock runs: at zero the stroke ends where it is, and what is in play settles.
      const onPaper = forReal && !ch.real && paper() !== null;
      if (onPaper && !canDraw(paper(), performance.now())) {
        finish();
        return { stop: "Time\u2019s up" };
      }
      const t0 = performance.now();
      if (!done && t0 - d.at < 150) return null;
      d.at = t0;
      const settings = g.drawing ?? { step: g.step, priceStep: g.priceStep, perDot: g.perDot };
      const placedAt = Date.now() + g.skew;
      const now: Stroke = { ...stroke, pts: stroke.pts.slice() };
      if (forReal && !ch.real && !onPaper) return ch.player ? "Connecting…" : "Sign in to play";
      if (ch.real && !ch.sessionOk) return "Getting ready, one moment";
      /*
        On chain each piece is a transaction the relayer pays for, and must stake its least (10¢). Ink is held
        back, drawn as it is, until a piece and the ink after it both reach that (`cutAt`): the piece goes up
        to that read, and the end of the line, however short, goes with the ink still held when the pen lifts.
      */
      const minStake = ch.real ? leastPiece(ch.hello) : 0n;
      const hold = () => {
        d.marks.push(now);
        if (d.marks.length > MARKS) d.marks.shift();
        drawing.current.set(line, d);
        return null;
      };
      let snap = now;
      let cut = -1;
      if (ch.real && !done) {
        const at = openFor(placedAt + g.placeLead);
        cut = cutAt(d.prev, d.marks, now, (st) => (st ? inkArea(st, at, settings.priceStep) : 0), toE6(settings.perDot), minStake);
        if (cut < 0) return hold();
        snap = d.marks[cut];
      }
      const bet = placeInk(snap, d.prev, settings.perDot, settings.priceStep, placedAt + g.placeLead, `${line}:${d.pieces}`, line, INK_EDGE_CELLS);
      if (!bet) {
        if (cut >= 0) return hold();
        finish();
        return done && !d.pieces ? "Draw ahead of the wait line" : null;
      }
      const area = d.area + bet.drawn.reduce((n, c) => n + c.area, 0);
      let charge = cents(areaCostOf(settings.perDot, area) - d.charged);
      if (ch.real) {
        const unit = unitFor(g.marketStep);
        const sections = toSections(bet.drawn, bet.openAt, toE6(settings.perDot), unit);
        const stake = stakeOf(sections);
        if (!sections.length) {
          if (cut >= 0) return hold();
          finish();
          return done && !d.pieces ? "Draw ahead of the wait line" : null;
        }
        if (stake < minStake) {
          if (!done) return hold();
          finish();
          // The whole line too little to send: nothing is placed or charged. The end of a placed line falls
          // short only if its held ink went behind the wait line before the pen lifted.
          return d.pieces ? null : `Draw a little more: at least ${usdE6(minStake)} a line`;
        }
        charge = Number(stake) / 1e6;
        if (charge > ch.balance) {
          finish();
          // Not enough for a piece at all: the deposit sheet once this drawing and any others are settled.
          const enough = ch.balance >= Number(minStake) / 1e6;
          if (!enough) topUp.current = true;
          return { stop: enough ? "Balance used up here · lower the price per dot" : "Not enough USDC in the game" };
        }
        const quote = feedRef.current.quote;
        if (!quote?.message || !quote.signature || !ch.hello || !ch.player || !ch.key) {
          finish();
          return "Waiting for a signed price";
        }
        const drawingId = drawingIdOf(line);
        const key = keyOf(drawingId, d.pieces);
        const from = d.prev?.pts.length ?? 0;
        const strokeBytes = bytesOf(encodeStroke({ t0: snap.t0, p0: snap.p0, rt: snap.rt, rp: snap.rp, from, pts: snap.pts.slice(from) }));
        const signedPiece = pieceFor(ch, level, drawingId, d.pieces, bet.openAt, settings.perDot, unit, quote.message, sections, strokeBytes);
        chainBets.current.set(key, { id: bet.id, stakeUsd: charge, drawing: drawingId, stroke: strokeBytes, tries: 0 });
        ch.nudge(-charge);
        sendPiece(ch, signedPiece, strokeBytes, quote.signature, (why) => letGo(key, why));
      }
      // Paper money runs out as real money does: the line ends where it can no longer be paid for.
      if (onPaper && !paperDebit(charge)) {
        finish();
        return { stop: "Paper money used up" };
      }
      bet.charged = charge;
      addChange(-charge, "stake");
      if (!drawing.current.has(line)) drawing.current.set(line, d);
      d.prev = snap;
      if (cut >= 0) d.marks = [...d.marks.slice(cut + 1), now];
      d.area = area;
      d.charged = cents(d.charged + charge);
      d.pieces++;
      if (d.pieces === 1 && onPaper) paperDrew();
      if (!g.bets.some((b) => !decided(b))) settledTotals.current = { committed: 0, returned: 0 };
      tally(line, bet.placedAt).open++;
      g.bets.push(bet);
      updateTotals();
      // Once: each call writes the whole practice state to storage and re-renders everyone reading it.
      if (ch.real || onPaper) {
        if (!practice().taught) setPractice({ taught: true });
      }
      else setPractice((st) => ({ balance: cents(st.balance - charge), taught: true, open: g.bets.filter((b) => !decided(b)) }));
      setLive(new Set(g.bets.filter((b) => !decided(b)).map((b) => b.group ?? b.id)).size);
      if (done) {
        const tip = stroke.pts.at(-1)!;
        g.fx.push({ kind: "placed", t: stroke.t0 + tip.t, price: stroke.p0 + tip.p, born: performance.now() });
      }
      finish();
      return null;
    },
    [fresh, updateTotals, level, letGo],
  );

  /* What the chain says: a piece placed (its bands, as priced there), refused, or settled. */
  useEffect(() => {
    if (!real) return;
    const g = game.current;
    const off = chain.client.on((m) => {
      if (m.type === "placed") {
        const key = keyOf(m.drawing, m.index);
        const sent = chainBets.current.get(key);
        if (!sent) return;
        betKeys.current.set(m.betId, key);
        const i = g.bets.findIndex((b) => b.id === sent.id);
        if (i < 0) return;
        const bet = g.bets[i];
        const staked = Number(m.staked) / 1e6;
        const drawn = bet.group ?? bet.id;
        if (!sealed.current.has(drawn)) {
          sealed.current.add(drawn);
          if (sealed.current.size > 200) sealed.current.clear();
          feel("placed");
        }
        const cells = m.sections.map((s) => ({ t: bet.openAt + s.second * 1000, lo: fromE8(BigInt(s.lo)), hi: fromE8(BigInt(s.hi)), area: Number(s.stake) / 1e6 / bet.perUnit, multiple: s.rung / 100, status: "live" as const }));
        g.bets[i] = { ...bet, status: cells.length ? "live" : "void", why: cells.length ? undefined : "The price moved, and none of it is in play now.", cells, charged: staked };
        if (sent.stakeUsd > staked + 1e-9) {
          chainRef.current.nudge(sent.stakeUsd - staked);
          addChange(cents(sent.stakeUsd - staked), "back");
          setReturnedInk({ id: sent.id, amount: cents(sent.stakeUsd - staked) });
        }
        chainBets.current.set(key, { ...sent, stakeUsd: staked });
        if (!cells.length) {
          chainBets.current.delete(key);
          const line = bet.group ?? bet.id;
          const t = tally(line, bet.placedAt);
          t.open--;
          if (t.open <= 0 && !drawing.current.has(line)) closeLine(line);
        }
        updateTotals();
      } else if (m.type === "account") {
        if (chainBets.current.size === 0) chainRef.current.resync();
      } else if (m.type === "refused") {
        letGo(keyOf(m.drawing, m.index), m.why);
      } else if (m.type === "settled") {
        const key = betKeys.current.get(m.betId);
        const sent = key ? chainBets.current.get(key) : undefined;
        if (!sent || !key) return;
        const i = g.bets.findIndex((b) => b.id === sent.id);
        if (i < 0) return;
        const bet = g.bets[i];
        let changed = false;
        let takeBack = 0;
        const cells = bet.cells.map((c, k) => {
          const hit = (m.hitMask >> k) & 1;
          const miss = (m.missMask >> k) & 1;
          if (!hit && !miss) return c;
          const status = hit ? ("hit" as const) : ("miss" as const);
          if (c.status === status) return c;
          changed = true;
          if (c.status === "hit" && !hit) takeBack += c.paid ?? 0;
          const stake = bet.perUnit * c.area;
          const gross = stake * c.multiple;
          return { ...c, status, paid: hit ? gross - Math.max(0, gross - stake) * ((chainRef.current.hello?.terms?.profitFeeBps ?? 1000) / 10_000) : undefined };
        });
        if (changed) {
          const wasDecided = decided(bet);
          const next: InkBet = { ...bet, cells, status: cells.every((c) => c.status !== "live") ? "done" : "live" };
          g.bets[i] = next;
          if (takeBack > 0) chainRef.current.nudge(-cents(takeBack));
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
        if (decided(g.bets[i]) || m.closed) {
          chainBets.current.delete(key);
          betKeys.current.delete(m.betId);
        }
        // No account asked for here: the relayer pushes it after every payout, and asking after every settlement cost
        // it three chain reads each time.
      }
    });
    return () => {
      off();
    };
  }, [real, chain.client, letGo, updateTotals]);

  /*
    The paper run's clock: moved on a few times a second, with whether any of its ink is still out, so at zero it
    stops taking ink, waits for what is in play to settle, and shows the end card once it has. In the background the
    clock stops where it is, and goes on from there when the app is back: thirty seconds on screen.
  */
  useEffect(() => {
    if (!paperOn) return;
    const tick = () => paperTick(game.current.bets.some((b) => !decided(b)) || drawing.current.size > 0);
    const shown = (s: string) => (s === "active" ? resumePaperRun() : pausePaperRun());
    shown(AppState.currentState);
    tick();
    const timer = setInterval(tick, 200);
    const sub = AppState.addEventListener("change", shown);
    return () => {
      clearInterval(timer);
      sub.remove();
    };
  }, [paperOn]);
  useEffect(() => {
    if (paperPhase !== "over") return;
    const run = paper();
    if (run) track("paper_ended", { pnl: paperResult(run, money).pnl, drawings: run.drawings, ended: "time" });
  }, [paperPhase]);
  /*
    Signing in, during a run or after it, ends it: the paper ink still out is thrown away here, unpaid, so none of it
    is ever judged or paid once the real balance has taken over. Signed out there is nothing else on the chart.
  */
  useEffect(() => {
    const run = paper();
    if (!me.signedIn || !run) return;
    if (run.phase !== "over") track("paper_ended", { pnl: paperResult(run, money).pnl, drawings: run.drawings, ended: "signed_in" });
    game.current.bets = [];
    lines.current.clear();
    drawing.current.clear();
    payouts.current.clear();
    settledTotals.current = { committed: 0, returned: 0 };
    // What is in play is counted again on the next trade, from the chart now emptied.
    updateTotals();
    endPaperRun();
  }, [me.signedIn, updateTotals]);
  const startPaper = (again: boolean) => {
    track(again ? "paper_again" : "paper_started");
    setResult(null);
    startPaperRun();
  };

  const painted = useRef(0);
  const onPreview = useCallback((p: Preview | null) => {
    setPreview(p);
    const n = p?.inPlay.length ?? 0;
    if (n > painted.current) feel("tick");
    painted.current = n;
  }, []);

  const shownBalance = forReal ? chain.balance : state.balance;
  const onboarding = useOnboarding(live);
  // Less in the balance than one piece stakes (10¢), with nothing in play: the deposit sheet, not the chart.
  const leastUsd = Number(leastPiece(chain.hello)) / 1e6;
  const cannotPlay: "signin" | "deposit" | null = !me.ready ? null : !me.signedIn ? null : real && chain.account !== null && chain.balance < leastUsd && live === 0 ? "deposit" : null;
  useEffect(() => {
    if (!topUp.current || !real || chain.account === null || live > 0) return;
    topUp.current = false;
    if (chain.balance < leastUsd) gate.openDeposit("short");
  }, [live, real, chain.account, chain.balance, gate, leastUsd]);
  const price = feed.ticks.at(-1)?.p ?? feed.bars.at(-1)?.c ?? 0;
  /*
    Signed out, the phone plays for practice money, as the web did before there was a game on chain: the game is
    there to try. Signing in (the bar) puts real USDC on Solana in play.
  */
  // Not while signed out: the blur and "Sign in to play" cover the game there.
  const signedOut = onboarding.step === "signin";
  const connecting = !signedOut && (!fresh || onboarding.step === "connecting");
  const board = useScoreboard();
  const [assetOpen, setAssetOpen] = useState(false);
  const { width } = useWindowDimensions();
  const c = useColors();

  const over = result && !result.voided && result.cost > 0 ? result : null;
  const overNet = over ? cents(over.won - over.cost) : 0;
  const overWon = overNet > 0;
  const overBig = over ? overWon && (over.won >= over.cost * 3 || (over.best ?? 0) >= 10) : false;
  const showingBatch = totals.drawings > 0 || totals.committed > 0;
  const displayedWon = forReal && !real ? 0 : showingBatch ? totals.returned : board.won;
  const pillTop = top + 116;
  /** On a paper run its clock takes the stroke pill's place, and what would be there sits under it. */
  const clockRoom = 46;
  // What skech keeps, as the relayer says it; nothing numeric until it has.
  const fees = chain.hello?.terms ?? null;
  // The balance, green and a little larger for a moment when money comes back, and what just moved it under it.
  const balance = (
    <>
      <Text className="text-[12px] text-muted-foreground">Balance</Text>
      <Bump on={gained > 0}>
        {cheer ? (
          <ProfitGlow color={dark ? "rgba(48,209,88,0.22)" : "rgba(52,199,89,0.2)"} delay={200} key={cheer.key}>
            <RisingMoney className={cn("font-semibold text-[16px]", gained ? "text-success-foreground" : "text-foreground")} style={{ fontVariant: ["tabular-nums"] }} value={shownBalance} />
          </ProfitGlow>
        ) : (
          <RisingMoney className={cn("font-semibold text-[16px]", gained ? "text-success-foreground" : "text-foreground")} style={{ fontVariant: ["tabular-nums"] }} value={shownBalance} />
        )}
      </Bump>
      <Ledger />
    </>
  );

  return (
    <View className="flex-1 overflow-hidden bg-background">
      {/* What the signed-out and end-of-run cards blur: on Android a blur needs its target named. */}
      <BlurTargetView pointerEvents="box-none" ref={blurTarget} style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0 }}>
      {/* The stage fills the screen; the market row, the pills and the dock float over it. */}
      {/* The stage as the web lays it out: from under the status bar, down to where the web's dock would sit, so
          the chart keeps the same room under the bar and over the dock. */}
      <View className="absolute inset-x-0" style={{ top: insets.top, bottom: bottom - 22 }}>
        {lib ? (
          <View className="flex-1" pointerEvents={cannotPlay ? "none" : "auto"}>
            <Stage game={game} onPlace={onPlace} onPreview={onPreview} onViewport={onViewport} />
          </View>
        ) : null}
        <Confetti colors={[c.success, c.brand, c.gold]} ref={confetti} />
        {cannotPlay ? <Pressable className="absolute inset-0" onPress={() => (feel("nope"), gate.openDeposit("tap"))} /> : null}
      </View>
      <LinearGradient colors={[c.bg, c.bg, dark ? "rgba(0,0,0,0)" : "rgba(255,255,255,0)"]} locations={[0, 0.8, 1]} pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, top: 0, height: top + 64 }} />

      <Arrive motion={MOTION.settle} pointerEvents="box-none" style={{ position: "absolute", left: 0, right: 0, top, zIndex: 20 }}>
        <View className="flex-row items-center justify-between gap-4 px-5 pt-1.5 pb-2.5" pointerEvents="box-none">
          <Pressable accessibilityLabel="Change asset: Bitcoin" className="flex-row items-center gap-2.5" onPress={() => setAssetOpen(true)}>
            <BitcoinMark size={36} />
            <View>
              <View className="flex-row items-center gap-[3px]">
                <Text className="font-semibold text-[13px] text-muted-foreground">Bitcoin</Text>
                <ChevronDownIcon color={c.muted} size={12} strokeWidth={2.4} />
              </View>
              {price ? <Price className={cn("font-bold text-foreground", width < 430 ? "text-[21px]" : "text-[24px]")} value={price} /> : <View className="my-[3px] h-6 w-32 rounded-md bg-muted" />}
            </View>
          </Pressable>
          {paperOn && !me.signedIn ? (
            <PaperMoney gained={gained > 0} />
          ) : forReal && (!me.ready || !me.signedIn || onboarding.step === "connecting") ? null : (
            <View className="flex-row items-center gap-[14px]">
              {/* The one balance on screen. Playing for real it opens the wallet: deposit, withdraw. */}
              {real ? (
                <WalletButton accessibilityLabel={`Balance ${money(shownBalance)}. Deposit or withdraw`} className="items-end">
                  {balance}
                </WalletButton>
              ) : (
                <View accessibilityLabel={forReal ? "Balance" : "Practice balance"} className="items-end">
                  {balance}
                </View>
              )}
              <Pressable accessibilityLabel={`Earned: ${money(displayedWon)}. Open this session`} className="items-end" onPress={gate.openScoreboard}>
                <Text className="text-[12px] text-muted-foreground">Earned</Text>
                <Text className={cn("font-semibold text-[16px]", displayedWon > 0 ? "text-success-foreground" : "text-foreground")} style={{ fontVariant: ["tabular-nums"] }}>
                  {displayedWon > 0 ? `+${money(displayedWon)}` : money(0)}
                </Text>
              </Pressable>
            </View>
          )}
        </View>
      </Arrive>

      {connecting ? (
        <View className="absolute inset-0 items-center justify-center" pointerEvents="none">
          <View className="flex-row items-center gap-2">
            <Spinner />
            <Text className="font-semibold text-[15px] text-muted-foreground">Connecting…</Text>
          </View>
        </View>
      ) : null}

      {paperOn ? <PaperClock top={top + 112} /> : null}
      {preview ? (
        <View className="absolute inset-x-0 z-20 items-center" pointerEvents="none" style={{ top: top + 112 + (paperOn ? clockRoom : 0) }}>
          <Arrive motion={MOTION.pillIn}>
            <View className="flex-row gap-4 rounded-full border-[0.5px] border-border bg-raised px-4 py-2" style={raised}>
              {preview.inPlay.length ? (
                <>
                  <Text className="text-[14px] text-muted-foreground">
                    In play <Text className="font-semibold text-foreground">{money(preview.cost)}</Text>
                  </Text>
                  <Text className="text-[14px] text-muted-foreground">
                    Could earn <Text className="font-semibold text-brand">{money(preview.high)}</Text>
                  </Text>
                </>
              ) : (
                <Text className="text-[14px] text-muted-foreground">Move to a spot with a multiplier on it</Text>
              )}
            </View>
          </Arrive>
        </View>
      ) : paperOn ? (
        !state.taught && fresh && paperPhase === "running" ? (
          <Pill top={pillTop + clockRoom}>
            <Text className="font-semibold text-[15px] text-foreground">Draw to the right of the line</Text>
          </Pill>
        ) : null
      ) : connecting ? null : onboarding.step ? (
        <Onboarding {...onboarding} top={pillTop} />
      ) : !state.taught && fresh ? (
        <Pill top={pillTop}>
          <Text className="font-semibold text-[15px] text-foreground">Draw to the right of the line</Text>
        </Pill>
      ) : null}

      {/* The round just over: a profit springs in, in the middle; a loss is a small toast bottom right, as on the web's phone. */}
      {over && !preview ? (
        <View className={cn("absolute z-20", overWon ? "inset-x-0 items-center" : "right-4")} key={over.key} pointerEvents="none" style={{ bottom: bottom + 78 }}>
          <Arrive motion={overBig ? MOTION.cardBig : overWon ? MOTION.cardIn : MOTION.cardSoft}>
            <View className={cn("border-[0.5px] bg-raised", overWon ? "items-center rounded-[20px] px-[22px] py-2.5" : "items-end rounded-2xl px-[18px] py-[9px]", overBig ? "border-success-foreground" : "border-border")} style={raised}>
              {/* Just the round's result: a profit shows everything that came back, a loss what it lost. */}
              {overWon && (over.streak ?? 0) >= 2 ? (
                <Arrive motion={MOTION.badgePop}>
                  <View className="mb-1 rounded-full px-2.5 py-0.5" style={{ backgroundColor: dark ? "rgba(111,146,255,0.16)" : "rgba(46,91,255,0.12)" }}>
                    <Text className="font-bold text-[12px] text-brand">{over.streak} in a row</Text>
                  </View>
                </Arrive>
              ) : null}
              <Text className={cn("text-muted-foreground", overWon ? "text-[13px]" : "text-[12px]")}>{overWon ? "Profit" : overNet < 0 ? "Loss" : "Even"}</Text>
              {overWon ? (
                <ProfitGlow color={dark ? "rgba(48,209,88,0.24)" : "rgba(52,199,89,0.22)"}>
                  <Text className={cn("font-bold text-success-foreground", overBig ? "text-[32px]" : "text-[26px]")} style={{ fontVariant: ["tabular-nums"] }}>
                    +{money(over.won)}
                  </Text>
                </ProfitGlow>
              ) : (
                <Text className={cn("font-semibold text-[18px]", overNet < 0 ? "text-destructive-foreground" : "text-foreground")} style={{ fontVariant: ["tabular-nums"] }}>
                  {signed(overNet)}
                </Text>
              )}
            </View>
          </Arrive>
        </View>
      ) : null}
      {over && overBig && !preview ? <Glow color={dark ? "rgba(48,209,88,0.42)" : "rgba(36,138,61,0.42)"} key={`glow-${over.key}`} top={cheer?.tier === 4} /> : null}

      {returnedInk && !preview && !over ? (
        <Arrive key={returnedInk.id} motion={MOTION.pillUp} pointerEvents="none" style={{ position: "absolute", right: 16, bottom: bottom + 78, zIndex: 20 }}>
          <View className="rounded-full border-[0.5px] border-border bg-raised px-3 py-1.5" style={raised}>
            <Text className="text-[12px] text-muted-foreground">
              Unpriced ink · <Text className="font-semibold text-foreground">{money(returnedInk.amount)} refunded</Text>
            </Text>
          </View>
        </Arrive>
      ) : null}

      <LinearGradient colors={[dark ? "rgba(0,0,0,0)" : "rgba(255,255,255,0)", c.bg, c.bg]} locations={[0, 0.7, 1]} pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 100 + bottom }} />
      <Arrive motion={MOTION.dockIn} style={{ position: "absolute", zIndex: 20, alignSelf: "center", bottom }}>
        <View className="flex-row items-stretch gap-2 rounded-[32px] border-[0.5px] border-border bg-dock p-2" style={{ width: Math.min(420, width - 32), height: 64 }}>
          <Pressable accessibilityLabel="Settings" className="size-12 items-center justify-center rounded-full bg-raised" onPress={() => setSettingsOpen(true)} style={({ pressed }) => ({ transform: [{ scale: pressed ? 0.97 : 1 }] })}>
            <SlidersHorizontalIcon color={c.fg} size={22} strokeWidth={1.8} />
          </Pressable>
          <InkControls amount={paperOn ? PAPER_PER_DOT : state.perDot} bottom={bottom} fixed={paperOn} onAmount={(n) => setPractice({ perDot: n })} onPen={(id) => setPractice({ brush: id })} pen={state.brush} />
        </View>
      </Arrive>

      </BlurTargetView>

      {/* Signed out: the game plays on behind, blurred. Signing in is the way to play; a tap anywhere opens it. Or
          thirty seconds on paper money first, to feel the game before signing in for it. */}
      {forReal && me.ready && !me.signedIn && !paperOn ? (
        <Pressable className="absolute inset-0 z-30 items-center justify-center gap-2" onPress={() => gate.openSignIn("overlay")}>
          <BlurView blurTarget={blurTarget} experimentalBlurMethod="dimezisBlurView" intensity={60} style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0 }} tint={dark ? "dark" : "light"} />
          <View className="w-64 gap-2">
            <Button className="w-full px-6" onPress={() => gate.openSignIn("overlay")}>
              Sign in to play
            </Button>
            <Button className="w-full px-6" onPress={() => startPaper(false)} variant="secondary">
              Try it free · 30 seconds
            </Button>
          </View>
        </Pressable>
      ) : null}
      {paperOn ? (
        <PaperEnd
          blurTarget={blurTarget}
          onAgain={() => startPaper(true)}
          onSignIn={() => {
            track("sign_in_opened", { from: "paper" });
            gate.openSignIn("paper");
          }}
        />
      ) : null}

      <Popover anchor={{ top: top + 50, left: 16 }} onClose={() => setAssetOpen(false)} open={assetOpen} width={256}>
        <Text className="px-2 pt-2 font-semibold text-[15px] text-foreground">Choose asset</Text>
        <Pressable accessibilityLabel="Bitcoin, selected" className="mt-3 h-14 flex-row items-center gap-3 rounded-xl px-2" onPress={() => setAssetOpen(false)}>
          <BitcoinMark size={32} />
          <View className="flex-1">
            <Text className="text-[16px] text-foreground">Bitcoin</Text>
            <Text className="text-xs text-muted-foreground">BTC / USD</Text>
          </View>
          <CheckIcon color={c.fg} size={18} />
        </Pressable>
      </Popover>

      <Sheet onClose={() => setSettingsOpen(false)} open={settingsOpen} title="Settings">
        <View className="overflow-hidden rounded-[14px] bg-muted">
          <ToggleRow checked={state.sound} detail="Pen, hits and round results" onChange={(on) => setPractice({ sound: on })} title="Sounds" />
          <View className="mx-4 h-px bg-border" />
          <ToggleRow checked={state.haptics} detail="A tap when ink goes in and when it hits" onChange={(on) => setPractice({ haptics: on })} title="Haptics" />
          <View className="mx-4 h-px bg-border" />
          <ToggleRow checked={dark} detail="Black paper, brighter ink" onChange={setDark} title="Dark mode" />
        </View>
        <View className="min-h-[60px] flex-row items-center justify-between gap-3 rounded-[14px] bg-muted px-4 py-2">
          <View>
            <Text className="text-[13px] text-muted-foreground">{forReal ? "Balance" : "Practice balance"}</Text>
            <Text className="font-semibold text-[17px] text-foreground" style={{ fontVariant: ["tabular-nums"] }}>
              {money(forReal ? chain.balance : state.balance)}
            </Text>
          </View>
          {forReal ? (
            real ? (
              <Text className="max-w-[55%] text-right text-muted-foreground text-xs">Add or withdraw from your balance, top right</Text>
            ) : (
              <Button
                onPress={() => {
                  setSettingsOpen(false);
                  gate.openSignIn("settings");
                }}
                size="md"
              >
                Sign in
              </Button>
            )
          ) : (
            <DepositButton onDeposit={(amount) => setPractice((st) => ({ balance: cents(st.balance + amount) }))} />
          )}
        </View>
        <View className="overflow-hidden rounded-[14px] bg-muted">
          <NavRow
            onPress={() => {
              setSettingsOpen(false);
              gate.openScoreboard();
            }}
            trailing={board.won > 0 ? <Text className="text-success-foreground">{`+${money(board.won)} earned`}</Text> : null}
          >
            This session
          </NavRow>
          <View className="mx-4 h-px bg-border" />
          <NavRow
            onPress={() => {
              setSettingsOpen(false);
              setHelp(true);
            }}
          >
            How it works
          </NavRow>
        </View>
        {/* The account's way out, both kinds: signing out here as in the bar's menu, and deleting it, which the stores ask for in the app. */}
        {me.signedIn ? (
          <View className="overflow-hidden rounded-[14px] bg-muted">
            <NavRow
              destructive
              onPress={() => {
                setSettingsOpen(false);
                me.signOut();
              }}
            >
              Sign out
            </NavRow>
            <View className="mx-4 h-px bg-border" />
            <NavRow
              destructive
              onPress={() => {
                setSettingsOpen(false);
                gate.openDeleteAccount();
              }}
            >
              Delete account
            </NavRow>
          </View>
        ) : null}
      </Sheet>

      <Sheet description={`Predict where Bitcoin goes next: draw it on the chart. ${paperOn ? "Paper money, on the live price: thirty seconds of practice." : forReal ? `Real USDC, on the live price, on ${chain.hello?.label ?? "Solana"}.` : "Practice money, on the live price."}`} onClose={() => setHelp(false)} open={help} title="How it works">
        {[
          "Draw the path you think the price will take over the next seconds, ahead of the live price. One full dot at your selected pen size costs the amount under Per dot. A longer stroke costs more; retracing ink in the same drawing adds no cost. The total cost rounds up to the next cent, once per drawing.",
          "Every part of your ink is a call on where the price will be in that second. The map shows what each spot returns if the price crosses it then, 1× up to 128× what it cost. The multiple comes from the chance the price reaches that spot: near the price and soon is likely and returns little; far away returns a lot. A wider pen puts more ink, and more money, on the same spots; it never changes what a spot returns. Only solid blue ink is in play. A correct call pays out immediately.",
          "Your call goes in as you draw it, not when you lift the pen: each new bit opens on the next second at the price for that moment, so a slow stroke is not priced on where the market has gone by the time you finish. Going back over your own ink costs nothing. The drawing’s cost rounds up to the cent once, over all of it.",
          "Placing a drawing takes its cost from your balance straight away; what just moved your balance shows under it. The number beside it is what you have earned: this round’s returns while ink is in play, this session’s otherwise. Tap it for the session so far. Correct calls pay out the moment the price touches them; the rest settles when its second closes.",
          `Ink starts counting one to two seconds ahead: everything right of the dashed wait line always counts, and it reaches ${RULES.horizon} seconds ahead.`,
        ].map((p) => (
          <Text className="text-[15px] text-foreground leading-relaxed" key={p.slice(0, 24)}>
            {p}
          </Text>
        ))}
        <Text className="text-[15px] text-muted-foreground leading-relaxed">
          {`Multiples are set from historical Bitcoin paths, price distance, time, volatility and momentum. Every part pays a rung of one ladder, 1.1× to 128×, set by its chance: ink exactly on a rung returns ${Math.round(difficulty(level).ladderBest * 100)}¢ per dollar, and everywhere else rounds down to the rung below, a little less on the side the price is moving towards. Ink too likely for ${difficulty(level).ladderFloor}× pays what its chance earns, never under 1×. This is not a guaranteed return. Calls are resolved using one-second price ranges. `}
          {paperOn
            ? `This practice run plays the real game\u2019s odds on paper money, with no fees and a cent a dot. Its paper money is gone when it ends.`
            : forReal
            ? `${fees ? `skech keeps ${fees.feeBps / 100}% of what you put in and ${fees.profitFeeBps / 100}% of the profit on every correct call.` : "skech keeps a share of what you put in and of the profit on every correct call."} Profits are paid from what other players lose; if that runs short, the rest is owed to you and paid as it refills.`
            : "Your balance is practice money saved on this phone."}
        </Text>
      </Sheet>
    </View>
  );
}

export type { Field };
