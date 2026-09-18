"use client";

import { ChevronUpIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  accountFor,
  candlesFor,
  fillsFor,
  type Market,
  ordersFor,
  type Position,
  type Timeframe,
} from "@/lib/market";
import { type ChartKind, type Level, type Overlay, PriceChart, type Study } from "./chart";
import { ChartToolbar } from "./chart-toolbar";
import { MarketBar } from "./market-bar";
import { OrderBook } from "./order-book";
import { Positions } from "./positions";
import { isResting, liquidationPrice, type Order, Ticket } from "./ticket";

const RAIL = "2.5rem";
const STUDY_LABEL: Record<Study, string> = { macd: "MACD", rsi: "RSI 14", volume: "Volume" };

export function Desk({
  market,
  positions,
  order,
  patch,
}: {
  market: Market;
  positions: Position[];
  order: Order;
  patch: (next: Partial<Order>) => void;
}) {
  const [timeframe, setTimeframe] = useState<Timeframe>("15m");
  const [kind, setKind] = useState<ChartKind>("candles");
  const [overlays, setOverlays] = useState<Overlay[]>(["ma"]);
  const [studies, setStudies] = useState<Study[]>(["volume"]);
  const [folded, setFolded] = useState<Study[]>([]);
  const [logScale, setLogScale] = useState(false);
  const [fitToken, setFitToken] = useState(0);
  const [bookShut, setBookShut] = useState(false);
  const [ticketShut, setTicketShut] = useState(false);
  const [positionsShut, setPositionsShut] = useState(false);

  const candles = useMemo(() => candlesFor(market, timeframe), [market, timeframe]);
  const account = useMemo(() => accountFor(positions), [positions]);
  const orders = useMemo(() => ordersFor(market), [market]);
  const fills = useMemo(() => fillsFor(market), [market]);

  const levels = useMemo(() => {
    const out: Level[] = [];
    const pay = Number.parseFloat(order.pay) || 0;
    const limit = Number.parseFloat(order.limit);
    const trigger = Number.parseFloat(order.trigger);
    if (isResting(order) && Number.isFinite(limit) && limit > 0) out.push({ id: "limit", label: "Your price", price: limit, tone: "brand" });
    if (order.triggered && Number.isFinite(trigger) && trigger > 0) out.push({ id: "trigger", label: "Trigger", price: trigger, tone: "fgMuted" });
    if (pay > 0) out.push({ id: "liquidation", label: "Wiped out", price: liquidationPrice(order, market), tone: "warning" });
    if (order.stopLoss !== null) out.push({ draggable: true, id: "stop", label: "Get out", onChange: (p) => patch({ stopLoss: p }), price: order.stopLoss, tone: "down" });
    if (order.takeProfit !== null) out.push({ draggable: true, id: "target", label: "Take profit", onChange: (p) => patch({ takeProfit: p }), price: order.takeProfit, tone: "up" });
    return out;
  }, [market, order, patch]);

  const columns = ["minmax(0, 1fr)", bookShut ? RAIL : "14rem", ticketShut ? RAIL : "22rem"].join(" ");

  return (
    <div
      // One board. The gap is a pixel and the board's ground is the border
      // colour, so every seam is a hairline and nothing is a card.
      className="grid min-w-0 gap-2 bg-muted/40 p-2 xl:h-full xl:[grid-template-columns:var(--cols)] xl:[grid-template-rows:auto_minmax(14rem,1fr)_auto]"
      style={{ ["--cols" as string]: columns }}
    >
      <MarketBar className="min-w-0 rounded-2xl border xl:col-span-2 xl:col-start-1 xl:row-start-1" market={market} />

      <section aria-label="Price" className="flex min-w-0 flex-col gap-2 rounded-2xl border bg-background p-2 xl:col-start-1 xl:row-start-2">
        <ChartToolbar
          kind={kind}
          logScale={logScale}
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
        <div className="h-[clamp(18rem,44vh,26rem)] min-h-0 xl:h-auto xl:min-h-0 xl:flex-1">
          <PriceChart
            candles={candles}
            fitToken={fitToken}
            kind={kind}
            levels={levels}
            logScale={logScale}
            onCloseStudy={(s) => {
              setStudies((c) => c.filter((x) => x !== s));
              setFolded((c) => (c.includes(s) ? c : [...c, s]));
            }}
            overlays={overlays}
            studies={studies}
          />
        </div>
        {folded.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {folded.map((s) => (
              <Button
                key={s}
                onClick={() => {
                  setFolded((c) => c.filter((x) => x !== s));
                  setStudies((c) => (c.includes(s) ? c : [...c, s]));
                }}
                size="sm"
                variant="outline"
              >
                {STUDY_LABEL[s]}
                <ChevronUpIcon />
              </Button>
            ))}
          </div>
        ) : null}
      </section>

      <OrderBook
        className="order-3 xl:order-none xl:col-start-2 xl:row-start-2"
        collapsed={bookShut}
        market={market}
        onCollapsed={setBookShut}
        onPickPrice={(price) => patch({ base: "limit", limit: price.toFixed(price >= 100 ? 2 : 4) })}
      />

      <Ticket
        className="order-2 xl:order-none xl:col-start-3 xl:row-span-3 xl:row-start-1 xl:h-full xl:overflow-hidden"
        collapsed={ticketShut}
        account={account}
        market={market}
        onCollapsed={setTicketShut}
        order={order}
        patch={patch}
      />

      <Positions
        className="order-4 xl:order-none xl:col-span-2 xl:col-start-1 xl:row-start-3"
        collapsed={positionsShut}
        fills={fills}
        mark={market.price}
        onCollapsed={setPositionsShut}
        orders={orders}
        positions={positions}
      />
    </div>
  );
}
