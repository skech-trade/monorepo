"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader } from "@/components/ui/empty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  type Fill,
  price as fmtPrice,
  type Position,
  type RestingOrder,
  signedPct,
  signedUsd,
  usd,
} from "@/lib/market";
import { cn } from "@/lib/utils";
import { Pane, Pill, Segmented } from "./controls";
import { announceSoon } from "./soon";

type Tab = "positions" | "orders" | "history";

function Nothing({ children }: { children: string }) {
  return (
    <Empty className="py-8 md:py-8">
      <EmptyHeader>
        <EmptyDescription>{children}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

const time = (t: number, withDay = false) =>
  new Date(t).toLocaleString(undefined, {
    ...(withDay ? { day: "numeric", month: "short" } : {}),
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
  });

export function Positions({
  positions,
  orders,
  fills,
  mark,
  collapsed,
  onCollapsed,
  className,
}: {
  positions: Position[];
  orders: RestingOrder[];
  fills: Fill[];
  mark: number;
  collapsed: boolean;
  onCollapsed: (collapsed: boolean) => void;
  className?: string;
}) {
  const [tab, setTab] = useState<Tab>("positions");

  return (
    <Pane
      className={className}
      collapsed={collapsed}
      direction="row"
      header={
        <Segmented
          label="Positions, orders or history"
          onChange={setTab}
          options={[
            { value: "positions", label: `Open ${positions.length}` },
            { value: "orders", label: `Waiting ${orders.length}` },
            { value: "history", label: `History ${fills.length}` },
          ]}
          size="sm"
          value={tab}
        />
      }
      label="Your positions, orders and history"
      onCollapsed={onCollapsed}
      title="Positions"
    >
      {tab === "positions" ? (
        positions.length === 0 ? (
          <Nothing>Nothing open.</Nothing>
        ) : (
          <Table className="text-xs">
            <TableHeader>
              <TableRow>
                <TableHead className="pl-3">Side</TableHead>
                <TableHead>Size</TableHead>
                <TableHead>In at</TableHead>
                <TableHead>Now</TableHead>
                <TableHead>Wiped out at</TableHead>
                <TableHead className="text-right">P&amp;L</TableHead>
                <TableHead className="pr-3 text-right" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {positions.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="pl-3"><Pill tone={p.side === "long" ? "up" : "down"}>{p.side === "long" ? "Long" : "Short"}</Pill></TableCell>
                  <TableCell className="figures">${usd(p.notional)} <span className="text-muted-foreground">at {p.leverage}×</span></TableCell>
                  <TableCell className="figures">${fmtPrice(p.entry)}</TableCell>
                  <TableCell className="figures">${fmtPrice(mark)}</TableCell>
                  <TableCell className="figures text-warning-foreground">${fmtPrice(p.liquidation)}</TableCell>
                  <TableCell className="text-right">
                    <span className={cn("figures font-medium", p.pnl >= 0 ? "text-up" : "text-down")}>{signedUsd(p.pnl)}</span>
                    <span className="figures ml-2 text-muted-foreground">{signedPct(p.pnlPct)}</span>
                  </TableCell>
                  <TableCell className="pr-3 text-right">
                    <span className="inline-flex gap-1">
                      <Button onClick={() => announceSoon("The desk is a preview. Draw is the part that runs.")} size="xs" variant="outline">Exits</Button>
                      <Button onClick={() => announceSoon("The desk is a preview. Draw is the part that runs.")} size="xs" variant="outline">Close</Button>
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )
      ) : null}

      {tab === "orders" ? (
        orders.length === 0 ? (
          <Nothing>Nothing waiting.</Nothing>
        ) : (
          <Table className="text-xs">
            <TableHeader>
              <TableRow>
                <TableHead className="pl-3">Side</TableHead>
                <TableHead>Order</TableHead>
                <TableHead>Filled</TableHead>
                <TableHead>Placed</TableHead>
                <TableHead className="pr-3 text-right" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {orders.map((o) => (
                <TableRow key={o.id}>
                  <TableCell className="pl-3"><Pill tone={o.side === "long" ? "up" : "down"}>{o.side === "long" ? "Long" : "Short"}</Pill></TableCell>
                  <TableCell className="figures">${usd(o.size)} <span className="text-muted-foreground">{o.type} at ${fmtPrice(o.price)}</span></TableCell>
                  <TableCell className="figures">{usd(o.filled * 100, 0)}%</TableCell>
                  <TableCell className="figures">{time(o.t)}</TableCell>
                  <TableCell className="pr-3 text-right"><Button onClick={() => announceSoon("The desk is a preview. Draw is the part that runs.")} size="xs" variant="outline">Cancel</Button></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )
      ) : null}

      {tab === "history" ? (
        fills.length === 0 ? (
          <Nothing>No trades yet.</Nothing>
        ) : (
          <Table className="text-xs">
            <TableHeader>
              <TableRow>
                <TableHead className="pl-3">Side</TableHead>
                <TableHead>Fill</TableHead>
                <TableHead>Fee</TableHead>
                <TableHead className="pr-3 text-right">When</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {fills.map((f) => (
                <TableRow key={f.id}>
                  <TableCell className="pl-3"><Pill tone={f.side === "long" ? "up" : "down"}>{f.side === "long" ? "Long" : "Short"}</Pill></TableCell>
                  <TableCell className="figures">${usd(f.size)} <span className="text-muted-foreground">at ${fmtPrice(f.price)}</span></TableCell>
                  <TableCell className="figures">${usd(f.fee)}</TableCell>
                  <TableCell className="figures pr-3 text-right">{time(f.t, true)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )
      ) : null}
    </Pane>
  );
}
