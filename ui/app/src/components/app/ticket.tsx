"use client";

import { ChevronDownIcon, TrendingDownIcon, TrendingUpIcon, XIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@/components/ui/collapsible";
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group";
import { Switch } from "@/components/ui/switch";
import { type Account, BALANCE, price as fmtPrice, type Market, priceDp, signedUsd, usd } from "@/lib/market";
import { cn } from "@/lib/utils";
import { FEE, liquidationPrice as venueLiquidation } from "@/lib/venue";
import { Pane, Segmented, Stat } from "./controls";
import { announceSoon } from "./soon";
import { DESK_STEPS, LeverageMeter } from "./leverage-meter";

/* ---- the order ------------------------------------------------------------ */

export type Side = "long" | "short";
type MarginMode = "cross" | "isolated";

export type Order = {
  side: Side;
  /** Cross the book, or rest on it. A stop is a market order that waits. */
  base: "market" | "limit";
  triggered: boolean;
  /** Raw input: "" and "0." are both states a user is in. */
  pay: string;
  limit: string;
  trigger: string;
  leverage: number;
  margin: MarginMode;
  stopLoss: number | null;
  takeProfit: number | null;
  reduceOnly: boolean;
  postOnly: boolean;
};

const LEVERAGE_PRESETS = [2, 5, 10, 25, 50];

export function emptyOrder(): Order {
  return {
    base: "market",
    leverage: 10,
    limit: "",
    margin: "cross",
    pay: "",
    postOnly: false,
    reduceOnly: false,
    side: "long",
    stopLoss: null,
    takeProfit: null,
    trigger: "",
    triggered: false,
  };
}

export function isResting(order: Order): boolean {
  return order.base === "limit";
}

function entryPrice(order: Order, market: Market): number {
  const limit = Number.parseFloat(order.limit);
  if (isResting(order) && Number.isFinite(limit) && limit > 0) return limit;
  return market.price;
}

export function liquidationPrice(order: Order, market: Market): number {
  const pay = Number.parseFloat(order.pay) || 0;
  return venueLiquidation(entryPrice(order, market), pay, order.leverage, order.side === "long" ? 1 : -1);
}

/* ---- pieces ---------------------------------------------------------------- */

function Label({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <span className="font-medium text-muted-foreground">{children}</span>
      {aside}
    </div>
  );
}

function Amount({
  value,
  onChange,
  placeholder = "0.00",
  unit,
  label,
  size = "lg",
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  unit: string;
  label: string;
  size?: "lg" | "default";
}) {
  return (
    <InputGroup>
      <InputGroupInput
        aria-label={label}
        className="figures"
        inputMode="decimal"
        onChange={(e) => onChange(e.target.value.replace(/[^0-9.]/g, ""))}
        placeholder={placeholder}
        size={size}
        value={value}
      />
      <InputGroupAddon align="inline-end">
        <InputGroupText>{unit}</InputGroupText>
      </InputGroupAddon>
    </InputGroup>
  );
}

function Flag({
  label,
  checked,
  onChange,
  disabled = false,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="flex flex-col">
        <span className={cn("text-sm", disabled && "text-muted-foreground")}>{label}</span>
        {hint ? <span className="text-muted-foreground text-xs">{hint}</span> : null}
      </span>
      <Switch aria-label={label} checked={checked && !disabled} disabled={disabled} onCheckedChange={onChange} />
    </div>
  );
}

/** A level you set here and drag on the chart. */
function Exit({
  label,
  price,
  tone,
  onToggle,
  onClear,
}: {
  label: string;
  price: number | null;
  tone: "down" | "up";
  onToggle: (on: boolean) => void;
  onClear: () => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <span className="font-medium text-muted-foreground text-xs">{label}</span>
        <Switch
          aria-label={label}
          checked={price !== null}
          className={tone === "down" ? "data-checked:bg-destructive" : "data-checked:bg-success"}
          onCheckedChange={onToggle}
        />
      </div>
      {price !== null ? (
        <div className={cn("flex h-7 items-center gap-3 rounded-full px-3 text-xs", tone === "down" ? "bg-destructive/8" : "bg-success/8")}>
          <span className={cn("figures font-medium", tone === "down" ? "text-down" : "text-up")}>${fmtPrice(price)}</span>
          <span className="ml-auto text-muted-foreground">Drag it on the chart</span>
          <Button aria-label={`Clear ${label.toLowerCase()}`} className="-mr-2" onClick={onClear} size="icon-xs" variant="ghost">
            <XIcon />
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/* ---- the ticket ------------------------------------------------------------ */

function healthTone(h: number): { tone: string; word: string } {
  if (h >= 2) return { tone: "text-up", word: "healthy" };
  if (h >= 1.25) return { tone: "", word: "steady" };
  if (h >= 1.1) return { tone: "text-warning-foreground", word: "tight" };
  return { tone: "text-down", word: "at risk" };
}

export function Ticket({
  market,
  account,
  order,
  patch,
  collapsed,
  onCollapsed,
  className,
}: {
  market: Market;
  account: Account;
  order: Order;
  patch: (next: Partial<Order>) => void;
  collapsed: boolean;
  onCollapsed: (collapsed: boolean) => void;
  className?: string;
}) {
  const [advanced, setAdvanced] = useState(false);
  const pay = Number.parseFloat(order.pay) || 0;
  const entry = entryPrice(order, market);
  const notional = pay * order.leverage;
  const units = entry > 0 ? notional / entry : 0;
  const resting = isResting(order);
  const maker = resting || order.postOnly;
  const fee = notional * (maker ? FEE.maker : FEE.taker);
  const long = order.side === "long";
  const exitAt = (kind: "stop" | "target") =>
    entry * (long ? (kind === "stop" ? 0.95 : 1.08) : kind === "stop" ? 1.05 : 0.92);
  const changed = [order.triggered, order.margin !== "cross", order.reduceOnly, order.postOnly && resting].filter(Boolean).length;

  return (
    <Pane
      bodyClassName="flex min-h-0 flex-1 flex-col"
      className={className}
      collapsed={collapsed}
      direction="column"
      header={
        <Segmented
          className="w-full"
          grow
          label="Direction"
          onChange={(side) =>
            patch({
              side,
              stopLoss: order.stopLoss === null ? null : entry * (side === "long" ? 0.95 : 1.05),
              takeProfit: order.takeProfit === null ? null : entry * (side === "long" ? 1.08 : 0.92),
            })
          }
          options={[
            { value: "long", tone: "up", label: (<><TrendingUpIcon />Long</>) },
            { value: "short", tone: "down", label: (<><TrendingDownIcon />Short</>) },
          ]}
          size="sm"
          value={order.side}
        />
      }
      label="Order ticket"
      onCollapsed={onCollapsed}
      title="Ticket"
    >
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 pt-1 pb-3">
        <div className="flex flex-col gap-2">
          <Label
            aside={
              resting ? (
                <Button className="h-auto p-0 text-xs" onClick={() => patch({ limit: market.price.toFixed(priceDp(market.price)) })} size="xs" variant="link">
                  Use mark
                </Button>
              ) : undefined
            }
          >
            Price
          </Label>
          <Segmented
            grow
            label="Order type"
            onChange={(base) => patch({ base })}
            options={[{ value: "market", label: "Market" }, { value: "limit", label: "Limit" }]}
            size="sm"
            value={order.base}
          />
          {resting ? (
            <Amount label="Limit price" onChange={(limit) => patch({ limit })} placeholder={fmtPrice(market.price)} size="default" unit="USD" value={order.limit} />
          ) : null}
        </div>

        <div className="flex flex-col gap-2">
          <Label aside={<span className="figures text-muted-foreground">${usd(account.free)} free</span>}>You pay</Label>
          <Amount label="Amount you pay" onChange={(pay) => patch({ pay })} unit="USDC" value={order.pay} />
          <div className="grid grid-cols-4 gap-1.5">
            {[0.25, 0.5, 0.75, 1].map((f) => (
              <Button key={f} onClick={() => patch({ pay: (BALANCE * f).toFixed(2) })} size="sm" variant="outline">
                {f === 1 ? "Max" : `${f * 100}%`}
              </Button>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <Label aside={<span className="figures text-muted-foreground">${usd(notional)}</span>}>{long ? "You get" : "You sell"}</Label>
          <InputGroup>
            <InputGroupInput aria-label="Position size" className={cn("figures", units === 0 && "text-muted-foreground")} readOnly size="lg" value={usd(units, units >= 1 ? 4 : 6)} />
            <InputGroupAddon align="inline-end">
              <InputGroupText>{market.symbol}</InputGroupText>
            </InputGroupAddon>
          </InputGroup>
        </div>

        <div className="flex flex-col gap-3">
          <Label>Leverage</Label>
          <LeverageMeter onChange={(leverage) => patch({ leverage })} stake={pay || 100} steps={DESK_STEPS} value={order.leverage} />
          <Segmented
            grow
            label="Leverage presets"
            onChange={(v) => patch({ leverage: Number(v) })}
            options={LEVERAGE_PRESETS.map((p) => ({ value: String(p), label: `${p}×` }))}
            size="sm"
            value={String(order.leverage)}
          />
        </div>

        <Exit label="Get out at" onClear={() => patch({ stopLoss: null })} onToggle={(on) => patch({ stopLoss: on ? exitAt("stop") : null })} price={order.stopLoss} tone="down" />
        <Exit label="Take profit at" onClear={() => patch({ takeProfit: null })} onToggle={(on) => patch({ takeProfit: on ? exitAt("target") : null })} price={order.takeProfit} tone="up" />

        <Collapsible onOpenChange={setAdvanced} open={advanced}>
          <CollapsibleTrigger
            render={<Button className="w-full justify-between" size="sm" variant="secondary" />}
          >
            {changed === 0 ? "Advanced" : `Advanced · ${changed} changed`}
            <ChevronDownIcon className={cn("transition-transform", advanced && "rotate-180")} />
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <div className="flex flex-col gap-4 pt-4">
              <div className="flex flex-col gap-2">
                <Flag
                  checked={order.triggered}
                  hint={order.triggered ? `Becomes a ${order.base === "limit" ? "stop limit" : "stop"} order` : undefined}
                  label="Only when the price reaches"
                  onChange={(triggered) => patch({ triggered })}
                />
                {order.triggered ? (
                  <Amount label="Trigger price" onChange={(trigger) => patch({ trigger })} placeholder={fmtPrice(market.price)} size="default" unit="trigger" value={order.trigger} />
                ) : null}
              </div>
              <div className="flex flex-col gap-2">
                <Label>Margin</Label>
                <Segmented grow label="Margin mode" onChange={(margin) => patch({ margin })} options={[{ value: "cross", label: "Cross" }, { value: "isolated", label: "Isolated" }]} size="sm" value={order.margin} />
              </div>
              <Flag checked={order.reduceOnly} label="Reduce only" onChange={(reduceOnly) => patch({ reduceOnly })} />
              <Flag checked={order.postOnly} disabled={!resting} hint={resting ? undefined : "Needs a limit price"} label="Post only" onChange={(postOnly) => patch({ postOnly })} />
            </div>
          </CollapsiblePanel>
        </Collapsible>

        {/* The account, where a trader looks for it: under the order. */}
        <div className="flex flex-col gap-1.5 border-t pt-4">
          <p className="mb-1 font-medium text-muted-foreground text-xs">Account</p>
          <Stat label="Equity" value={`$${usd(account.equity)}`} />
          <Stat label="Unrealised" tone={account.unrealised >= 0 ? "text-up" : "text-down"} value={signedUsd(account.unrealised)} />
          <Stat label="Margin used" value={`$${usd(account.used)}`} />
          <Stat label="Free" value={`$${usd(account.free)}`} />
          <Stat
            label="Health"
            tone={Number.isFinite(account.health) ? healthTone(account.health).tone : "text-muted-foreground"}
            value={Number.isFinite(account.health) ? `${usd(account.health, 1)}× ${healthTone(account.health).word}` : "no positions"}
          />
        </div>
      </div>

      {/* The footer stays put: the four figures you read before you press. */}
      <div className="flex flex-col gap-3 border-t p-3">
        <div className="flex flex-col gap-1.5">
          <Stat label="Entry price" value={`$${fmtPrice(entry)}`} />
          <Stat label="Wiped out at" tone="text-warning-foreground" value={notional > 0 ? `$${fmtPrice(liquidationPrice(order, market))}` : "none"} />
          <Stat label="Margin used" value={pay > 0 ? `$${usd(pay)}` : "none"} />
          <Stat label={maker ? "Fee (maker)" : "Fee (taker)"} value={`$${usd(fee)}`} />
        </div>
        {/* The one filled button on the desk, in the colour of the direction. */}
        <Button
          className={cn("w-full", long ? "border-success bg-success text-white shadow-success/24 hover:bg-success/90" : "")}
          disabled={pay <= 0}
          onClick={() => announceSoon("The desk is a preview. Draw is the part that runs.")}
          size="lg"
          variant={long ? "default" : "destructive"}
        >
          {pay <= 0 ? "Enter an amount" : `${long ? "Long" : "Short"} ${market.name}`}
        </Button>
      </div>
    </Pane>
  );
}
