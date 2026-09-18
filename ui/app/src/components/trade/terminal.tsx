"use client";

import { ChevronUpIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { AccountBar } from "./account-bar";
import { AppBar } from "./app-bar";
import {
  type ChartKind,
  type Level,
  type Overlay,
  PriceChart,
  type Study,
} from "./chart";
import { ChartToolbar } from "./chart-toolbar";
import { DrawScreen } from "./draw-screen";
import { MarketHeader } from "./market-header";
import {
  accountFor,
  candlesFor,
  fillsFor,
  type Market,
  ordersFor,
  type Position,
  TIMEFRAMES,
  type Timeframe,
} from "./market";
import { type Mode, shows } from "./mode";
import { OrderBook } from "./order-book";
import {
  emptyOrder,
  isResting,
  liquidationPrice,
  type Order,
  OrderTicket,
} from "./order-ticket";
import { Positions } from "./positions";

/**
 * The trading screen.
 *
 * Desk is three columns on a wide screen, which is the arrangement every
 * terminal has converged on and therefore the one a reader already knows: the
 * chart takes the room, the book sits between the chart and the ticket, and
 * the ticket is on the right under your hand. Positions run underneath,
 * because that is the thing you scan rather than operate.
 *
 * Every region except the chart folds. Nobody uses the whole screen — a
 * scalper watches the tape and never opens the positions list, someone holding
 * for a week wants the chart as wide as it goes — so rather than guess, each
 * column collapses to a labelled rail and the grid takes the space back.
 *
 * Draw is the chart and nothing else.
 *
 * The order state lives here rather than inside the ticket. The chart draws
 * the stop, the target, the liquidation and the limit; the stop and target are
 * draggable on the chart and typed in the ticket; the book writes the limit
 * price. That is one piece of state with four views on it, not four components
 * trying to agree.
 */

/** Rail width when a column is folded. Matches the chevron's hit area. */
const RAIL = "2.75rem";

/** What a folded study calls itself in the tray. Matches the pane's own chip. */
const STUDY_LABEL: Record<Study, string> = {
  macd: "MACD",
  rsi: "RSI 14",
  volume: "Volume",
};

export function Terminal({
  market,
  positions,
}: {
  market: Market;
  positions: Position[];
}) {
  const [mode, setMode] = useState<Mode>("draw");
  const [blurred, setBlurred] = useState(false);
  const [timeframe, setTimeframe] = useState<Timeframe>("15m");
  const [order, setOrder] = useState<Order>(emptyOrder);
  const [kind, setKind] = useState<ChartKind>("candles");
  const [overlays, setOverlays] = useState<Overlay[]>(["ma"]);
  const [studies, setStudies] = useState<Study[]>(["volume"]);
  /**
   * Studies folded away from their own pane, rather than turned off.
   *
   * A pane that vanishes with no trace of itself is a pane you have to go and
   * find in the toolbar again. These keep a chip at the foot of the chart,
   * pointing down, which is where the pane went.
   */
  const [folded, setFolded] = useState<Study[]>([]);
  const [logScale, setLogScale] = useState(false);
  const [fitToken, setFitToken] = useState(0);

  const [bookShut, setBookShut] = useState(false);
  const [ticketShut, setTicketShut] = useState(false);
  const [positionsShut, setPositionsShut] = useState(false);
  /** The header and the account fold together: one row, one control. */
  const [topShut, setTopShut] = useState(false);

  const patch = (next: Partial<Order>) =>
    setOrder((current) => ({ ...current, ...next }));

  const desk = mode === "desk";

  /**
   * Draw is pinned to the fastest bar.
   *
   * The reader's own choice is kept in `timeframe` rather than overwritten, so
   * a desk trader who was on 4h and flips to Draw and back finds 4h still
   * selected. Switching modes should not quietly edit a setting.
   */
  const shownTimeframe: Timeframe = shows("timeframes", mode)
    ? timeframe
    : TIMEFRAMES[0];

  const candles = useMemo(
    () => candlesFor(market, shownTimeframe),
    [market, shownTimeframe],
  );
  const account = useMemo(() => accountFor(positions), [positions]);
  const orders = useMemo(() => ordersFor(market), [market]);
  const fills = useMemo(() => fillsFor(market), [market]);

  /**
   * Only the levels that mean something right now.
   *
   * A liquidation line with no position is a threat about nothing, and a limit
   * line on a market order is a price you are not asking for. Each appears the
   * moment it starts being true, which is also how a reader learns what it is.
   */
  const levels = useMemo(() => {
    if (!desk) return [];
    const out: Level[] = [];
    const pay = Number.parseFloat(order.pay) || 0;
    const limit = Number.parseFloat(order.limit);
    const trigger = Number.parseFloat(order.trigger);

    if (isResting(order) && Number.isFinite(limit) && limit > 0) {
      out.push({
        id: "limit",
        label: "Your price",
        price: limit,
        tone: "brand",
      });
    }
    if (order.triggered && Number.isFinite(trigger) && trigger > 0) {
      out.push({
        id: "trigger",
        label: "Trigger",
        price: trigger,
        tone: "fgMuted",
      });
    }
    if (pay > 0) {
      out.push({
        id: "liquidation",
        label: "Wiped out",
        price: liquidationPrice(order, market),
        tone: "warning",
      });
    }
    if (order.stopLoss !== null) {
      out.push({
        draggable: true,
        id: "stop",
        label: "Get out",
        onChange: (price) => patch({ stopLoss: price }),
        price: order.stopLoss,
        tone: "down",
      });
    }
    if (order.takeProfit !== null) {
      out.push({
        draggable: true,
        id: "target",
        label: "Take profit",
        onChange: (price) => patch({ takeProfit: price }),
        price: order.takeProfit,
        tone: "up",
      });
    }
    return out;
  }, [desk, market, order]);

  /** A click in the book sets the price the ticket would rest at. */
  const pickPrice = (price: number) => {
    patch({
      // A price picked off the book is a resting order by intent; switching
      // from market here is what the reader meant by clicking it.
      base: "limit",
      limit: price.toFixed(price >= 100 ? 2 : 4),
    });
  };

  const shownOverlays = shows("studies", mode) ? overlays : [];
  const shownStudies = shows("studies", mode) ? studies : [];

  /**
   * The grid, rebuilt from what is open.
   *
   * An explicit template rather than utility classes: there are four
   * combinations of the two folding columns, and enumerating them as Tailwind
   * strings is four chances to mistype one.
   */
  const columns = [
    "minmax(0, 1fr)",
    shows("book", mode) ? (bookShut ? RAIL : "15rem") : null,
    shows("ticket", mode) ? (ticketShut ? RAIL : "24rem") : null,
  ]
    .filter(Boolean)
    .join(" ");

  const toolbar = (
    <ChartToolbar
      className="px-1 pb-2"
      kind={kind}
      logScale={logScale}
      mode={mode}
      onFit={() => setFitToken((n) => n + 1)}
      onKind={setKind}
      onLogScale={setLogScale}
      onOverlays={setOverlays}
      onStudies={setStudies}
      onTimeframe={setTimeframe}
      overlays={overlays}
      studies={studies}
      timeframe={timeframe}
    />
  );


  const chart = (
    <PriceChart
      candles={candles}
      fitToken={fitToken}
      kind={shows("studies", mode) ? kind : "candles"}
      legend={shows("studies", mode)}
      levels={levels}
      logScale={logScale}
      onCloseStudy={(study) => {
        setStudies((current) => current.filter((s) => s !== study));
        setFolded((current) =>
          current.includes(study) ? current : [...current, study],
        );
      }}
      overlays={shownOverlays}
      studies={shownStudies}
    />
  );

  return (
    <div
      // Blurring the figures is a real feature on a shared screen, and it is
      // one CSS rule rather than a prop threaded through thirty components:
      // every number on this page already carries `figures` for its digits.
      className="mx-auto flex w-full max-w-[120rem] flex-col gap-4 p-3 sm:p-4"
      data-blurred={blurred ? "" : undefined}
    >
      <AppBar
        account={account}
        blurred={blurred}
        mode={mode}
        onBlurred={setBlurred}
        onMode={setMode}
      />

      {desk ? (
        /*
         * One grid for the whole desk, three rows deep.
         *
         *   header + account │ ticket
         *   chart    │ book  │   ↑
         *   positions        │ spans all three
         *
         * The account block used to sit above the ticket, which pushed the
         * ticket down by its own height and put the buy/sell button below the
         * fold on a laptop. It is on the left now and the ticket runs the full
         * height of the page, so the side is at the top of it and the button at
         * the bottom and neither needs a scroll.
         *
         * The chart row is the flexible one. Everything else is sized by its
         * content, so the height the ticket asks for lands in the chart rather
         * than as an empty half-panel under the volume histogram — which is
         * what a fixed chart height and a stretching grid row were producing.
         */
        <>
          <div
            /*
             * A definite height, so `1fr` means something.
             *
             * The cap used to be a constant on the chart row — "the viewport
             * less about 28rem" — which was a guess that had to be re-guessed
             * every time the header or the positions list changed height, and
             * was 16px out. Giving the grid the height it actually has
             * (viewport, less the page padding, the app bar and one gap) lets
             * the chart row take whatever the other two rows leave. Fold the
             * account away and the chart grows into it on its own.
             */
            className="grid min-w-0 gap-4 xl:h-[calc(100svh-6rem)] xl:[grid-template-columns:var(--cols)] xl:[grid-template-rows:auto_minmax(15rem,1fr)_auto]"
            style={{ ["--cols" as string]: columns }}
          >
            {/*
              Three parts to two, fixed.

              This was `auto` + `1fr` — the header took what it needed and the
              account took the rest — which sized the row from its contents and
              so moved the seam every time the contents changed. Folding the
              24h figures away took 240px out of the header and handed them to
              the account, and the two panels swapped widths in front of you.
              A proportional split lands within three pixels of where `auto`
              put the seam and then stays there, open or shut.
            */}
            <div className="grid min-w-0 items-stretch gap-4 xl:col-span-2 xl:col-start-1 xl:row-start-1 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
              <MarketHeader
                collapsed={topShut}
                market={market}
                onCollapsed={setTopShut}
              />
              {shows("account", mode) ? (
                <AccountBar
                  account={account}
                  collapsed={topShut}
                  onCollapsed={setTopShut}
                />
              ) : null}
            </div>

            <section
              aria-label="Price"
              className="panel flex min-w-0 flex-col rounded-4xl p-3 xl:col-start-1 xl:row-start-2"
            >
              {toolbar}
              {/* Fixed on a phone, where nothing is stretching it; flexible on
                  the desk, with a floor that grows as studies are added so
                  turning on MACD cannot squeeze the candles into a strip. */}
              <div
                className="h-[clamp(18rem,44vh,26rem)] min-h-0 xl:h-auto xl:flex-1"
                style={{
                  // 16rem plus 4 per study. It was 20 plus 5, which at a
                  // 900px laptop viewport ran the chart row 40px into the
                  // positions panel below it and clipped its tab strip.
                  ["--study-floor" as string]: `${16 + shownStudies.length * 4}rem`,
                  minHeight: undefined,
                }}
              >
                <div className="h-full min-h-0 xl:min-h-[var(--study-floor)]">
                  {chart}
                </div>
              </div>

              {/* Where a folded pane went. Same chip, same panel, chevron the
                  other way — so the fold reads as a drawer rather than a
                  delete, and reopening it does not mean hunting the toolbar.
                  It points up, at the space the pane will come back into. */}
              {folded.length > 0 ? (
                <div className="flex flex-wrap gap-1.5 px-1 pt-2">
                  {folded.map((study) => (
                    <Button
                      className="rounded-full"
                      key={study}
                      onClick={() => {
                        setFolded((current) =>
                          current.filter((s) => s !== study),
                        );
                        setStudies((current) =>
                          current.includes(study)
                            ? current
                            : [...current, study],
                        );
                      }}
                      size="sm"
                      variant="outline"
                    >
                      {STUDY_LABEL[study]}
                      <ChevronUpIcon />
                    </Button>
                  ))}
                </div>
              ) : null}
            </section>

            {shows("book", mode) ? (
              <OrderBook
                className="order-3 xl:order-none xl:col-start-2 xl:row-start-2"
                collapsed={bookShut}
                market={market}
                onCollapsed={setBookShut}
                onPickPrice={pickPrice}
              />
            ) : null}

            {shows("ticket", mode) ? (
              <OrderTicket
                account={account}
                className={cn(
                  // Stacked on a phone the ticket comes straight after the
                  // chart: you are far likelier to want to trade than to read
                  // twenty levels of depth on a 390px screen.
                  "order-2 xl:order-none xl:col-start-3 xl:row-span-3 xl:row-start-1",
                  // Exactly its three rows, and it scrolls inside that. It used
                  // to be `self-start` with a `max-height` of the viewport,
                  // which is taller than the rows it spans — so the ticket hung
                  // 44px below the grid and put the page back into scroll after
                  // everything else had been sized to fit.
                  !ticketShut && "xl:h-full xl:overflow-hidden",
                )}
                collapsed={ticketShut}
                market={market}
                mode={mode}
                onCollapsed={setTicketShut}
                order={order}
                patch={patch}
              />
            ) : null}

            {shows("positions", mode) ? (
              <Positions
                className="order-4 xl:order-none xl:col-span-2 xl:col-start-1 xl:row-start-3"
                collapsed={positionsShut}
                fills={fills}
                mark={market.price}
                mode={mode}
                onCollapsed={setPositionsShut}
                orders={orders}
                positions={positions}
              />
            ) : null}
          </div>
        </>
      ) : (
        /*
         * Draw. The chart, the line, and the tray that quotes it.
         *
         * Fills the viewport under the app bar and does not scroll: on a
         * phone the tray sits at the bottom where a thumb is, and a page that
         * scrolls under a finger that is trying to draw is a page that loses
         * the line. `svh` because the URL bar counts.
         */
        <DrawScreen
          className="h-[calc(100svh-5.25rem)] sm:h-[calc(100svh-5.75rem)]"
          market={market}
          order={order}
          patch={patch}
        />
      )}


    </div>
  );
}
