"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Empty as CossEmpty, EmptyDescription, EmptyHeader } from "@/components/ui/empty";
import { cn } from "@/lib/utils";
import { CollapsiblePanel } from "./collapsible";
import { Pill, Segmented } from "./controls";
import {
  type Fill,
  price as fmtPrice,
  type Position,
  type RestingOrder,
  signedPct,
  signedUsd,
  usd,
} from "./market";
import { type Mode, shows } from "./mode";

/**
 * What you have on, what is waiting, and what you have done.
 *
 * xStream draws this as a nine-column table at 10px. That is the right shape
 * for a desk with forty positions across six markets, and the wrong one here:
 * there is one market, a handful of rows, and a reader who wants to know
 * whether they are up — not to compare entry prices down a column.
 *
 * So each row reads as a sentence from the left — long, 5×, six hundred and
 * seventy dollars — and lands on the number that matters at the right, with
 * the supporting figures under it. The three tabs are back now that all three
 * have something in them; they were removed when two of them were permanently
 * empty, which is a different thing.
 */

type Tab = "positions" | "orders" | "history";

/** A label and figure pair from a row's second line. */
function Detail({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="text-fg-subtle">{label}</span>
      <span className={cn("figures", tone)}>{value}</span>
    </span>
  );
}

function Empty({ children }: { children: string }) {
  return (
    <CossEmpty className="py-8 md:py-8">
      <EmptyHeader>
        <EmptyDescription className="text-caption text-fg-subtle">
          {children}
        </EmptyDescription>
      </EmptyHeader>
    </CossEmpty>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return (
    <li className="rowable flex flex-wrap items-center gap-x-4 gap-y-3 rounded-3xl px-4 py-3.5">
      {children}
    </li>
  );
}

function PositionRow({
  position,
  mark,
}: {
  position: Position;
  mark: number;
}) {
  const up = position.pnl >= 0;

  return (
    <Row>
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <Pill tone={position.side === "long" ? "up" : "down"}>
          {position.side === "long" ? "Long" : "Short"}
        </Pill>
        <div className="min-w-0">
          <p className="figures truncate text-caption">
            ${usd(position.notional)}
            <span className="text-fg-subtle"> at {position.leverage}×</span>
          </p>
          <p className="mt-0.5 flex flex-wrap gap-x-3 text-kicker">
            <Detail label="In at" value={`$${fmtPrice(position.entry)}`} />
            <Detail label="Now" value={`$${fmtPrice(mark)}`} />
            <span className="hidden sm:contents">
              <Detail
                label="Wiped out at"
                tone="text-warning"
                value={`$${fmtPrice(position.liquidation)}`}
              />
            </span>
          </p>
        </div>
      </div>

      <div className="text-right">
        <p
          className={cn(
            "figures text-caption font-medium",
            up ? "text-up" : "text-down",
          )}
        >
          {signedUsd(position.pnl)}
        </p>
        <p className="figures mt-0.5 text-kicker text-fg-subtle">
          {signedPct(position.pnlPct)}
        </p>
      </div>

      <div className="flex gap-1.5">
        <Button className="rounded-full" size="sm" variant="outline">
          Exits
        </Button>
        <Button className="rounded-full" size="sm" variant="outline">
          Close
        </Button>
      </div>
    </Row>
  );
}

function OrderRow({ order }: { order: RestingOrder }) {
  return (
    <Row>
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <Pill tone={order.side === "long" ? "up" : "down"}>
          {order.side === "long" ? "Long" : "Short"}
        </Pill>
        <div className="min-w-0">
          <p className="figures truncate text-caption">
            ${usd(order.size)}
            <span className="text-fg-subtle">
              {" "}
              {order.type === "stop" ? "stop" : "limit"} at $
              {fmtPrice(order.price)}
            </span>
          </p>
          <p className="mt-0.5 flex flex-wrap gap-x-3 text-kicker">
            <Detail
              label="Filled"
              value={`${usd(order.filled * 100, 0)}%`}
            />
            <Detail
              label="Placed"
              value={new Date(order.t).toLocaleTimeString(undefined, {
                hour: "2-digit",
                hour12: false,
                minute: "2-digit",
              })}
            />
          </p>
        </div>
      </div>

      <Button className="rounded-full" size="sm" variant="outline">
        Cancel
      </Button>
    </Row>
  );
}

function FillRow({ fill }: { fill: Fill }) {
  return (
    <Row>
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <Pill tone={fill.side === "long" ? "up" : "down"}>
          {fill.side === "long" ? "Long" : "Short"}
        </Pill>
        <div className="min-w-0">
          <p className="figures truncate text-caption">
            ${usd(fill.size)}
            <span className="text-fg-subtle"> at ${fmtPrice(fill.price)}</span>
          </p>
          <p className="mt-0.5 flex flex-wrap gap-x-3 text-kicker">
            <Detail label="Fee" value={`$${usd(fill.fee)}`} />
            <Detail
              label=""
              value={new Date(fill.t).toLocaleString(undefined, {
                day: "numeric",
                hour: "2-digit",
                hour12: false,
                minute: "2-digit",
                month: "short",
              })}
            />
          </p>
        </div>
      </div>
    </Row>
  );
}

export function Positions({
  positions,
  orders,
  fills,
  mark,
  mode,
  collapsed,
  onCollapsed,
  className,
}: {
  positions: Position[];
  orders: RestingOrder[];
  fills: Fill[];
  /** The current price, for the "now" figure on each position. */
  mark: number;
  mode: Mode;
  collapsed: boolean;
  onCollapsed: (collapsed: boolean) => void;
  className?: string;
}) {
  const [tab, setTab] = useState<Tab>("positions");
  const tabs = shows("orderHistory", mode);
  const showing: Tab = tabs ? tab : "positions";

  return (
    <CollapsiblePanel
      className={className}
      collapsed={collapsed}
      direction="row"
      header={
        tabs ? (
          <Segmented
            label="Positions, orders or history"
            onChange={setTab}
            options={[
              { value: "positions", label: `Open ${positions.length}` },
              { value: "orders", label: `Waiting ${orders.length}` },
              { value: "history", label: `History ${fills.length}` },
            ]}
            value={tab}
          />
        ) : undefined
      }
      label="Your positions, orders and history"
      onCollapsed={onCollapsed}
      title={`What you have on · ${positions.length}`}
    >

      {showing === "positions" ? (
        positions.length === 0 ? (
          <Empty>Nothing open.</Empty>
        ) : (
          <ul className="flex flex-col">
            {positions.map((position) => (
              <PositionRow key={position.id} mark={mark} position={position} />
            ))}
          </ul>
        )
      ) : null}

      {showing === "orders" ? (
        orders.length === 0 ? (
          <Empty>Nothing waiting.</Empty>
        ) : (
          <ul className="flex flex-col">
            {orders.map((order) => (
              <OrderRow key={order.id} order={order} />
            ))}
          </ul>
        )
      ) : null}

      {showing === "history" ? (
        fills.length === 0 ? (
          <Empty>No trades yet.</Empty>
        ) : (
          <ul className="flex flex-col">
            {fills.map((fill) => (
              <FillRow fill={fill} key={fill.id} />
            ))}
          </ul>
        )
      ) : null}
    </CollapsiblePanel>
  );
}
