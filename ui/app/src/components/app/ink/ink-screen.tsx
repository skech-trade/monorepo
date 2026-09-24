"use client";

import { CircleHelpIcon, HistoryIcon, Volume2Icon, VolumeXIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { DOT_BETS, type Features, features, field, type Library, openFor, readLibrary, RULES, START_BALANCE, stepFor } from "@skech/core/dots";
import { type Cell, cost, decided, hitShare, judge, open, place, quote, refund, type Stroke, won } from "@skech/core/ink";
import { MarketHeader } from "@/components/app/market-header";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { type Market, marketBySymbol } from "@/lib/market";
import { usePhone } from "@/lib/phone";
import { Sheet, SheetDescription, SheetHeader, SheetPanel, SheetPopup, SheetTitle } from "@/components/ui/sheet";
import { useBinance } from "@/lib/binance";
import { BRUSH_PX, buzz, cents, practice, record, setPractice, sound, usePractice } from "@/lib/practice";
import { cn } from "@/lib/utils";
import { fmtMultiple, type Game, type Preview, Stage } from "./stage";
import { MoneyButtons, penFor, PenPicker } from "./ink-controls";

/**
 * skech. Draw ahead of the Bitcoin price; wherever it runs through your ink
 * pays.
 *
 * Ink is priced by area: every bit of it costs the same, and pays what the
 * map of the odds says there. The rules are `@skech/core/dots`, the same
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
/** A second's dots are missed only this long after it ends, for the same reason. */
const CLOSE_AFTER_MS = 600;
const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const signed = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${money(Math.abs(n))}`;

/**
 * Bitcoin's day, from Binance, for the market header: the same figures the
 * trading screen shows, from the market the game is played on. Read once a
 * minute; the price itself comes from the live trades.
 */
function useDay(): { changePct: number; high: number; low: number; volume: number } | null {
  const [day, setDay] = useState<{ changePct: number; high: number; low: number; volume: number } | null>(null);
  useEffect(() => {
    let live = true;
    const read = () =>
      fetch("https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT")
        .then((r) => r.json())
        .then((d: { priceChangePercent: string; highPrice: string; lowPrice: string; quoteVolume: string }) => {
          if (live) setDay({ changePct: +d.priceChangePercent, high: +d.highPrice, low: +d.lowPrice, volume: +d.quoteVolume });
        })
        .catch(() => undefined);
    void read();
    const timer = setInterval(read, 60_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  return day;
}

/** One icon button on the rail beside the chart, as the trading screen's tools are. */
function Tool({ words, children }: { words: string; children: React.ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipPopup>{words}</TooltipPopup>
    </Tooltip>
  );
}

export function InkScreen() {
  const feed = useBinance("BTCUSDT");
  const state = usePractice();
  /* The paths every chance is measured on: a file of their own, fetched once. Nothing is priced until it is in. */
  const [lib, setLib] = useState<Library | null>(null);
  useEffect(() => {
    let live = true;
    void fetch("/dots-lib.bin")
      .then((r) => r.arrayBuffer())
      .then((b) => live && setLib(readLibrary(new Uint8Array(b))))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  const [preview, setPreview] = useState<Preview | null>(null);
  const [help, setHelp] = useState(false);
  const [live, setLive] = useState(0);
  const [result, setResult] = useState<{ key: string; won: number; cost: number; share: number; voided: boolean } | null>(null);
  useEffect(() => {
    if (!result) return;
    const t = setTimeout(() => setResult(null), 2600);
    return () => clearTimeout(t);
  }, [result]);
  const [fresh, setFresh] = useState(false);
  const game = useRef<Game>({ bars: [], ticks: [], skew: 0, field: null, step: 1, perDot: state.perDot, brush: BRUSH_PX[state.brush], bets: [], quote: null, fx: [], hint: !state.taught, dark: false });
  /** The market as the last quarter-second read it, for pricing a stroke while it is drawn. */
  const market = useRef<Features | null>(null);

  // For tests and debugging in development: the live game, from the console.
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") (window as unknown as { __dots?: Game }).__dots = game.current;
  }, []);

  useEffect(() => {
    const g = game.current;
    g.perDot = penFor(state.brush).perUnit;
    g.brush = BRUSH_PX[state.brush];
    g.hint = !state.taught;
  }, [state.perDot, state.brush, state.taught]);

  /*
    Every quarter second: whether the page is dark, whether the prices are
    fresh, and the field, priced for a drawing placed now. The dot size
    follows the market, but only while nothing of yours is on it.
  */
  const connected = feed.connected && lib !== null;
  useEffect(() => {
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
      const at = openFor(nowMs);
      const f = features(g.bars, at);
      if (!f) return;
      market.current = f;
      /*
        The price step follows the market, once it has moved well off the
        old one so it does not flicker. Drawings already placed keep their
        own prices, so it can change under them. Held while they were live,
        a market that got busy was mapped in hundreds of tiny steps, and the
        page stalled drawing them.
      */
      const want = stepFor(f.sigma, f.price);
      if (g.field === null || Math.abs(Math.log(want / g.step)) > Math.log(1.6)) g.step = want;
      const t0 = performance.now();
      g.field = field(lib, f, at, g.step);
      slow("field", t0, `rows ${g.field.rows} step ${g.step}`);
    };
    tick();
    const timer = setInterval(tick, 250);
    // What the stroke being drawn would cost and pay, second by second, on the market as it stands.
    game.current.quote = (st: Stroke) => {
      const g = game.current;
      const f = market.current;
      if (!lib || !f) return null;
      const t0 = performance.now();
      const q = quote(lib, st, Date.now() + g.skew, g.step, f);
      slow("quote", t0, `cells ${q.cells.length} pts ${st.pts.length} rt ${Math.round(st.rt)} rp ${st.rp.toFixed(2)} step ${g.step}`);
      let spend = 0;
      let low = Number.POSITIVE_INFINITY;
      let high = 0;
      const inPlay: Cell[] = [];
      const out: Cell[] = [];
      q.cells.forEach((s, i) => {
        const m = q.multiples[i];
        if (m === null) return void out.push(s);
        spend += g.perDot * s.area;
        low = Math.min(low, m);
        high = Math.max(high, m);
        inPlay.push(s);
      });
      return { cost: cents(spend), low: Number.isFinite(low) ? low : 0, high, inPlay, out };
    };
    return () => clearInterval(timer);
  }, [connected, lib]);

  /*
    Every trade: open what is due, judge what is live. Drawings placed
    before a reload come back once there are prices to judge them on; dots
    older than those prices cannot be judged either way, and come back.
  */
  const restored = useRef(false);
  const { bars, ticks, skew, version } = feed;
  useEffect(() => {
    const g = game.current;
    g.bars = bars;
    g.ticks = ticks;
    g.skew = skew;
    const latest = bars.at(-1);
    if (!latest || !lib) return;
    const nowMs = Date.now() + skew;
    let credit = 0;
    if (!restored.current && bars.length > 300) {
      restored.current = true;
      const firstBar = bars[0].t + 5000;
      for (const bet of practice().open) {
        if (bet.openAt >= firstBar) {
          g.bets.push(bet);
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
        bet = open(bet, lib, bars);
        credit += refund(bet);
        if (bet.status === "void") g.fx.push({ kind: "placed", t: bet.openAt, price: latest.c, born: performance.now() });
        changed = true;
      }
      if (bet.status === "live") {
        const from = Math.min(...bet.cells.filter((d) => d.status === "live").map((d) => d.t));
        for (const bar of bars) {
          if (bar.t < from) continue;
          const before = bet;
          bet = judge(bet, bar, bar.t + 1000 + CLOSE_AFTER_MS <= nowMs);
          if (bet === before) continue;
          changed = true;
          // One burst a second, however many cells of ink the price crossed in it, with what they paid together.
          const fresh2 = bet.cells.filter((d, k) => d.status === "hit" && before.cells[k].status !== "hit");
          if (fresh2.length) {
            const paid = cents(fresh2.reduce((a, d) => a + (d.paid ?? 0), 0));
            credit += paid;
            const best = Math.max(...fresh2.map((d) => d.multiple));
            const lo = Math.min(...fresh2.map((d) => d.lo));
            const hi = Math.max(...fresh2.map((d) => d.hi));
            g.fx.push({ kind: "hit", t: fresh2[0].t + 500, price: Math.min(hi, Math.max(lo, bar.c)), born: performance.now(), text: `+${money(paid)}`, big: best >= 10 });
            if (practice().sound) sound.hit(best);
            buzz(best >= 10 ? 40 : 12);
          }
          if (bet.status !== "live") break;
        }
      }
      if (bet.status === "done" || bet.status === "void") {
        if (g.bets[i].status !== bet.status) {
          const got = won(bet);
          const paidFor = cost(bet) - refund(bet);
          if (bet.status === "done") {
            const hitCells = bet.cells.filter((d) => d.status === "hit");
            setResult({ key: bet.id, won: got, cost: paidFor, share: hitShare(bet), voided: false });
            record({ id: bet.id, at: bet.placedAt, cost: paidFor, won: got, hits: hitCells.length, dots: bet.cells.length, best: Math.max(0, ...hitCells.map((d) => d.multiple)) });
          } else setResult({ key: bet.id, won: 0, cost: 0, share: 0, voided: true });
        }
      }
      g.bets[i] = bet;
    }
    if (credit) setPractice((s) => ({ balance: cents(s.balance + credit) }));
    if (changed || credit) setPractice({ open: g.bets.filter((b) => !decided(b)) });
    setLive(g.bets.filter((b) => !decided(b)).length);
    // Keep finished drawings only as long as their dots are still fading.
    g.bets = g.bets.filter((b) => !decided(b) || b.cells.some((d) => d.t + 3000 > nowMs));
  }, [bars, ticks, skew, version, lib]);

  const onPlace = useCallback(
    (stroke: Stroke): string | null => {
      const g = game.current;
      const latest = g.bars.at(-1);
      if (!latest || !fresh || !g.field) return "Waiting for live prices";
      if (g.bets.filter((b) => !decided(b)).length >= RULES.maxOpen) return `${RULES.maxOpen} drawings at a time`;
      const s = practice();
      const nowMs = Date.now() + g.skew;
      const q = g.quote?.(stroke);
      if (!q || !q.inPlay.length) return "Draw where the map is coloured";
      // What ink costs is the pen's: a small dot, a dime a unit; a large one, half a dollar.
      const bet = place(stroke, penFor(s.brush).perUnit, g.step, nowMs, crypto.randomUUID());
      if (!bet) return "Draw further ahead";
      if (cost(bet) > s.balance + 1e-9) return "Not enough practice money";
      g.bets.push(bet);
      if (process.env.NODE_ENV !== "production") (window as unknown as { __lastBet?: unknown }).__lastBet = bet;
      const mid = bet.drawn[Math.floor(bet.drawn.length / 2)];
      g.fx.push({ kind: "placed", t: mid.t + 500, price: (mid.lo + mid.hi) / 2, born: performance.now() });
      setPractice((st) => ({ balance: cents(st.balance - cost(bet)), taught: true, open: g.bets.filter((b) => !decided(b)) }));
      setLive(g.bets.filter((b) => !decided(b)).length);
      if (s.sound) {
        sound.wake();
        sound.place();
      }
      buzz(8);
      return null;
    },
    [fresh],
  );

  /* A soft tick as the ink grows, so drawing is heard as well as seen. */
  const painted = useRef(0);
  const onPreview = useCallback((p: Preview | null) => {
    setPreview(p);
    const n = p?.inPlay.length ?? 0;
    if (n > painted.current && practice().sound) {
      sound.wake();
      sound.paint();
    }
    painted.current = n;
  }, []);

  const broke = state.balance < DOT_BETS[0] && live === 0;
  const recent = state.history.slice(0, 8);
  const price = feed.ticks.at(-1)?.p ?? feed.bars.at(-1)?.c ?? 0;
  const phone = usePhone();
  const day = useDay();
  const [listOpen, setListOpen] = useState(false);
  const base = marketBySymbol("BTC");
  const btc: Market | null = base
    ? { ...base, price, changePct: day?.changePct ?? 0, change: day ? (price * day.changePct) / 100 : 0, high24h: day?.high ?? 0, low24h: day?.low ?? 0, volume24h: day?.volume ?? 0 }
    : null;

  /*
    The pen where the trading screen has size and pace, and the money beside
    it. Picking a pen picks what its ink costs. Drawing places itself when the
    pen lifts, straight from the balance, so there is no button to press for it.
  */
  const controls = (
    <div className="flex w-full items-center gap-1.5 sm:w-auto sm:gap-2">
      <PenPicker className="max-sm:flex-[1.4]" onPen={(id) => setPractice({ brush: id, perDot: penFor(id).perUnit })} pen={state.brush} />
      <MoneyButtons className="flex items-center gap-1.5 max-sm:contents sm:gap-2" onDeposit={(amount) => setPractice((st) => ({ balance: cents(st.balance + amount) }))} />
    </div>
  );

  /* The practice balance: beside the controls on a desk, over the chart's top right on a phone, in the same coat as the market beside it. */
  const balance = (
    <span className="flex h-10 items-center gap-1.5 rounded-lg px-2 text-sm max-sm:border max-sm:border-input max-sm:bg-card/85 max-sm:px-3 max-sm:backdrop-blur-sm">
      <span className="figures font-medium">{money(state.balance)}</span>
      <span className="text-muted-foreground text-xs max-[380px]:hidden">Practice</span>
    </span>
  );

  const soundButton = (
    <Button aria-label={state.sound ? "Mute" : "Sound on"} aria-pressed={state.sound} className="size-8 rounded-lg sm:size-10 sm:rounded-xl" onClick={() => setPractice({ sound: !state.sound })} size="icon" variant="ghost">
      {state.sound ? <Volume2Icon /> : <VolumeXIcon />}
    </Button>
  );

  return (
    /* Edge to edge on a phone, a card on a desk: the trading screen's own shape. */
    <section aria-label="Draw" className="flex min-h-[24rem] flex-1 flex-col overflow-hidden border-0 bg-background sm:m-2 sm:rounded-2xl sm:border">
      {/* Market on the left, the controls hard right, on the chart's own header. On a phone both are over the chart and in the footer instead. */}
      <div className="hidden flex-wrap items-center gap-1.5 border-b px-2 py-2 sm:flex sm:gap-2 sm:px-3">
        {btc ? <MarketHeader className="max-sm:hidden sm:w-auto" market={btc} /> : null}
        {phone ? null : (
          <div className="ml-auto flex items-center gap-2">
            {balance}
            {controls}
          </div>
        )}
      </div>
      <div className="flex min-h-0 flex-1 gap-2 sm:px-2 sm:pt-2">
        {/* The rail beside the chart, as the trading screen's drawing tools are. */}
        <div className="hidden sm:block">
          <div className="flex shrink-0 flex-col items-center gap-1.5 self-start rounded-2xl border bg-card p-1.5 [&_svg]:size-5">
            <Tool words="Your drawings">
              <Button aria-label="Your drawings" className="size-10 rounded-xl" onClick={() => setListOpen(true)} size="icon" variant="ghost">
                <HistoryIcon />
              </Button>
            </Tool>
            <span aria-hidden="true" className="my-0.5 h-px w-6 shrink-0 bg-border" />
            <Tool words={state.sound ? "Sound off" : "Sound on"}>{soundButton}</Tool>
            <Tool words="How it works">
              <Button aria-label="How it works" className="size-10 rounded-xl" onClick={() => setHelp(true)} size="icon" variant="ghost">
                <CircleHelpIcon />
              </Button>
            </Tool>
          </div>
        </div>
        <div className="relative min-w-0 flex-1">
          {/* On a phone: the market over the top left of the chart, the balance over the top right. */}
          {phone && btc ? (
            <div className="absolute top-4 left-3 z-10">
              <MarketHeader market={btc} />
            </div>
          ) : null}
          {phone ? <div className="absolute top-4 right-3 z-10 max-[380px]:top-16">{balance}</div> : null}
          {/* Bottom left on a phone, the same round buttons the trading screen keeps there. */}
          {phone ? (
            <div className="pointer-events-none absolute bottom-2 left-2 z-10 flex w-13 flex-col items-center gap-1.5 [&>*]:pointer-events-auto">
              <Button aria-label={`Your drawings, ${state.history.length}`} className="size-10 shrink-0 rounded-full border bg-card/85 backdrop-blur-sm" onClick={() => setListOpen(true)} size="icon" variant="outline">
                <HistoryIcon />
              </Button>
              <Button aria-label="How it works" className="size-10 shrink-0 rounded-full border bg-card/85 backdrop-blur-sm" onClick={() => setHelp(true)} size="icon" variant="outline">
                <CircleHelpIcon />
              </Button>
            </div>
          ) : null}

          {lib ? <Stage className="absolute inset-0 size-full" game={game} onPlace={onPlace} onPreview={onPreview} /> : null}
          {!fresh ? (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center" role="status">
              <p className="text-sm text-muted-foreground">{!lib ? "Getting the chart ready…" : "Waiting for live prices…"}</p>
            </div>
          ) : null}

          {/* While drawing: what the ink costs, and what it pays. */}
          {preview ? (
            <div className="-translate-x-1/2 pointer-events-none absolute top-16 left-1/2 z-10 flex items-center gap-2 whitespace-nowrap rounded-full bg-foreground px-4 py-2 font-medium text-background text-sm shadow-lg sm:top-3" role="status">
              {preview.inPlay.length ? (
                <>
                  <span className="figures tabular-nums">{money(preview.cost)}</span>
                  <span className="opacity-40">·</span>
                  <span>
                    pays <span className="figures tabular-nums">{preview.low === preview.high ? fmtMultiple(preview.high) : `${fmtMultiple(preview.low)} to ${fmtMultiple(preview.high)}`}</span>
                  </span>
                </>
              ) : (
                <span>Draw where the chart glows</span>
              )}
            </div>
          ) : null}

          {/* A finished drawing, for a moment: how much of it the price ran through, and what it came to. */}
          {result && !preview ? (
            <div
              className={cn(
                "-translate-x-1/2 pointer-events-none absolute top-16 left-1/2 z-10 flex animate-[fade-in_0.2s_ease-out] items-center gap-2 whitespace-nowrap rounded-full border px-4 py-2 font-medium text-sm shadow-lg sm:top-3",
                result.won > result.cost ? "border-success/30 bg-success/12 text-success-foreground" : "bg-card/90 text-muted-foreground backdrop-blur",
              )}
              key={result.key}
              role="status"
            >
              {!result.voided ? (
                <>
                  <span>{result.share > 0 ? `Hit ${Math.max(1, Math.round(100 * result.share))}% of it` : "Missed"}</span>
                  <span className="opacity-50">·</span>
                  <span className="figures font-semibold tabular-nums">{signed(cents(result.won - result.cost))}</span>
                </>
              ) : (
                <span>The price moved before it opened. Nothing spent.</span>
              )}
            </div>
          ) : null}
        </div>
      </div>

      {/* The bar under the chart, as on the trading screen: what to do, and your recent drawings. On a phone, the controls. */}
      <div className="flex flex-col gap-2 border-t px-3 py-3">
        {phone ? null : (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
            <p className="mr-auto text-muted-foreground">
              <span className="font-medium text-foreground">Draw where you think Bitcoin goes.</span>{" "}
              <span>The ink the price runs through pays what the chart shows there. Practice money, no sign-in.</span>
            </p>
            {recent.length ? (
              <ol aria-label="Your last drawings" className="flex items-center gap-1.5">
                {recent.slice(0, 5).map((r) => {
                  const net = cents(r.won - r.cost);
                  return (
                    <li className={cn("figures rounded-md px-2 py-1 text-xs", net > 0 ? "bg-success/10 text-success-foreground" : "bg-muted text-muted-foreground")} key={r.id}>
                      {signed(net)}
                    </li>
                  );
                })}
              </ol>
            ) : null}
            <Button onClick={() => setListOpen(true)} variant="outline">
              Drawings <span className="figures text-muted-foreground">{state.history.length}</span>
            </Button>
          </div>
        )}
        {phone ? (
          <div className="flex items-center gap-1.5">
            {controls}
          </div>
        ) : null}
      </div>

      <Sheet onOpenChange={setListOpen} open={listOpen}>
        <SheetPopup className="sm:max-w-md" side="right" variant="inset">
          <SheetHeader className="px-6 pt-8">
            <SheetTitle className="font-semibold text-2xl tracking-tight">Your drawings</SheetTitle>
            <SheetDescription>
              Practice balance <span className="figures text-foreground">{money(state.balance)}</span>
              {state.streak > 0 ? ` · ${state.streak} in a row with a hit` : ""}
            </SheetDescription>
          </SheetHeader>
          <SheetPanel className="flex flex-col gap-2 px-6 pb-8">
            {state.history.length ? (
              <ul className="flex flex-col divide-y rounded-2xl border">
                {state.history.map((r) => {
                  const net = cents(r.won - r.cost);
                  return (
                    <li className="flex items-center justify-between gap-3 px-4 py-3 text-sm" key={r.id}>
                      <span className="text-muted-foreground">
                        {new Date(r.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                        <span className="figures"> · ink {money(r.cost)}</span>
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
            <SheetTitle className="font-semibold text-2xl tracking-tight">How it works</SheetTitle>
            <SheetDescription>Practice money, on the real Bitcoin price.</SheetDescription>
          </SheetHeader>
          <SheetPanel className="flex flex-col gap-4 px-6 pb-8 text-sm leading-relaxed">
            <p>Ahead of the price is a map of the odds. Draw on it. Your ink is your bet, and it is priced by area: every bit of ink costs the same, so a longer or thicker stroke costs more.</p>
            <p>Wherever the price runs through your ink, that part pays what the map shows there. Near the price is likely and pays a little. Far from it, in price or in time, pays a lot: the multiples are written on the map.</p>
            <p>Ink drawn too soon or outside the priced map stays faint and costs nothing. One unit is one price step of ink for one second.</p>
            <p>A drawing starts on the next second. The first second after that is never part of it, and it reaches {RULES.horizon} seconds ahead.</p>
            <p className="text-muted-foreground">
              Payouts are based on real Bitcoin paths from similar moments, starting from {Math.round(RULES.rtp * 100)}% of fair odds and adjusted for momentum. Only the part of your ink touched by the price pays. Your balance is practice money saved in this browser.
            </p>
          </SheetPanel>
        </SheetPopup>
      </Sheet>
    </section>
  );
}
