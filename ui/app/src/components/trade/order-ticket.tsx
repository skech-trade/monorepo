"use client";

import { TrendingDownIcon, TrendingUpIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { CollapsiblePanel } from "./collapsible";
import { Disclosure, Segmented, Stat, Switch } from "./controls";
import {
  type Account,
  BALANCE,
  price as fmtPrice,
  type Market,
  priceDp,
  usd,
} from "./market";
import { type Mode, shows } from "./mode";

/**
 * The order ticket.
 *
 * Field order is xStream's, because the sequence is right: which way, how
 * much, how hard, where you get out, then what it costs, then the button. What
 * changed is the material — xStream draws a line under every one of those and a
 * border around every input, so eleven controls arrive as eleven boxes. Here
 * the panel is the only object, the fields are wells cut into it, and the
 * grouping is done by space.
 *
 * What is behind "Advanced", and why those four:
 *
 *   A trader sets a direction, an amount, a leverage and usually an exit on
 *   every single order. Those stay out. Margin mode is answered once and then
 *   never again; reduce-only and post-only are for managing an existing book
 *   rather than opening a position; and a trigger turns the order into a
 *   different kind of order, which is a decision most people never make. Those
 *   four fold away.
 *
 *   Stop loss and take profit are *not* behind it, even though they look like
 *   they belong with the rest. Most people use them, and on this product in
 *   particular "where do I get out" is the question the whole landing page is
 *   built around. Hiding it would be hiding the point.
 *
 * The fields are large, 56px. This is the half of the screen a person actually
 * operates, and a ticket of 28px controls is a form, not a thing you use.
 *
 * Nothing is wired. The caption under the button says so, rather than letting
 * a live-looking button imply otherwise.
 */

export type Side = "long" | "short";
export type OrderType = "market" | "limit" | "stop" | "stop-limit";
export type MarginMode = "cross" | "isolated";

export type Order = {
  side: Side;
  /**
   * What the order does when it fires: cross the book, or rest on it.
   *
   * Stored as base plus `triggered` rather than as a four-way type, because
   * that is what the four are. A stop order is a market order that waits for a
   * price; a stop-limit is a limit order that waits for a price. Modelling it
   * as four peers means a segmented control with four options where two of
   * them need an extra field, and the reader has to learn which. Modelling it
   * as two plus a switch means the switch can live under Advanced and the
   * visible control stays the two everybody uses.
   */
  base: "market" | "limit";
  triggered: boolean;
  /** Raw input, not a number: "" and "0." are both states a user is in. */
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

export const LEVERAGE_PRESETS = [2, 5, 10, 25, 50, 100];

/** Fractions of notional. Resting orders make the book, so they pay less. */
const TAKER_FEE = 0.0005;
const MAKER_FEE = 0.0002;

/** The maintenance buffer, as a fraction of the initial margin. */
const MAINTENANCE = 0.9;

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

/** The name the exchange would call it. */
export function orderType(order: Order): OrderType {
  if (!order.triggered) return order.base;
  return order.base === "limit" ? "stop-limit" : "stop";
}

/** True when the order rests on the book rather than crossing it. */
export function isResting(order: Order): boolean {
  return order.base === "limit";
}

/** The price an order fills at: its own, if it has one, else the mark. */
export function entryPrice(order: Order, market: Market): number {
  const limit = Number.parseFloat(order.limit);
  if (isResting(order) && Number.isFinite(limit) && limit > 0) return limit;
  return market.price;
}

export function liquidationPrice(order: Order, market: Market): number {
  const entry = entryPrice(order, market);
  const move = MAINTENANCE / order.leverage;
  return order.side === "long" ? entry * (1 - move) : entry * (1 + move);
}

/**
 * A label above a field, and whatever the field wants on the right of it.
 *
 * Baseline, not centre: the aside is always a figure, and two pieces of text
 * on a row line up on their baselines rather than on their boxes.
 */
function FieldHead({ label, aside }: { label: string; aside?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 px-1">
      <span className="text-kicker text-fg-subtle">{label}</span>
      {aside}
    </div>
  );
}

/** A label and a switch on one line. The shape of every advanced flag. */
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
    <div className="flex items-center justify-between gap-3 px-1">
      <span className="flex flex-col gap-0.5">
        <span
          className={cn(
            "text-kicker",
            disabled ? "text-fg-subtle/50" : "text-fg-subtle",
          )}
        >
          {label}
        </span>
        {hint ? (
          <span className="text-kicker text-fg-subtle/70">{hint}</span>
        ) : null}
      </span>
      <Switch
        checked={checked && !disabled}
        label={label}
        onChange={(next) => {
          if (!disabled) onChange(next);
        }}
      />
    </div>
  );
}

/**
 * One of the shortcuts under the amount field.
 *
 * Our `Button`, not a hand-rolled pill — and a `Button` rather than a
 * `Segmented` segment, which is the distinction worth keeping: pressing "50%"
 * sets the amount to half the balance and then nothing is selected, because
 * typing a digit makes 50% no longer true. The leverage presets below *are* a
 * selection, and are a `Segmented` for exactly that reason.
 */
function Chip({
  children,
  onClick,
}: {
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <Button
      className="flex-1 rounded-full"
      onClick={onClick}
      size="lg"
      variant="outline"
    >
      {children}
    </Button>
  );
}

/**
 * A figure you type into.
 *
 * `inputMode="decimal"` rather than `type="number"`: a number input puts
 * spinners on a price, swallows the value on a stray scroll over it, and on
 * iOS still offers a keyboard with no decimal point in some locales.
 */
function Amount({
  value,
  onChange,
  placeholder = "0.00",
  suffix,
  label,
  size = "lg",
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  suffix?: ReactNode;
  label: string;
  size?: "lg" | "md";
}) {
  return (
    <div
      className={cn(
        "well flex items-center gap-2 rounded-2xl px-4 focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-focus",
        size === "lg" ? "h-14" : "h-11",
      )}
    >
      <input
        aria-label={label}
        className={cn(
          "figures min-w-0 flex-1 bg-transparent outline-none placeholder:text-fg-subtle",
          size === "lg" ? "text-title" : "text-caption",
        )}
        inputMode="decimal"
        onChange={(event) =>
          onChange(event.target.value.replace(/[^0-9.]/g, ""))
        }
        placeholder={placeholder}
        value={value}
      />
      {suffix}
    </div>
  );
}

/**
 * A level you set here and drag on the chart. Stop loss and take profit.
 *
 * Half a row wide on the desk, because the two of them go side by side — and
 * that is what took the cross out. Turning the switch off already sets the
 * level to null, so the ✕ beside the price was a second control for the one
 * thing the switch does, and it was the first thing a 174px column could not
 * afford. "Drag it on the chart" went the same way and comes back once, under
 * the pair, rather than twice, once under each.
 *
 * One well rather than a floating label above a tinted box. Two reasons, and
 * the first is that it was the flimsiest thing in the ticket: every other
 * control here is a surface you can see the edges of, and these were two words
 * and a switch sitting on the panel with nothing under them.
 *
 * The second is arithmetic. Setting a level used to cost 52px — a whole second
 * block — which is why the ticket had to reserve room it then spent most of
 * its life not using. Inside the well the price is a second line, 21px, and
 * the difference is what let everything else grow.
 */
function Exit({
  label,
  price,
  tone,
  onToggle,
}: {
  label: string;
  price: number | null;
  tone: "down" | "up";
  onToggle: (on: boolean) => void;
}) {
  const on = price !== null;
  const tint = tone === "down" ? "text-down" : "text-up";

  return (
    <div
      className={cn(
        "flex min-h-16 flex-col justify-center gap-1 rounded-2xl px-4 py-3 transition-colors duration-micro ease-smooth-out",
        on ? (tone === "down" ? "bg-down/10" : "bg-up/10") : "well",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className={cn("truncate text-kicker", on ? tint : "text-fg-subtle")}>
          {label}
        </span>
        <Switch checked={on} label={label} onChange={onToggle} tone={tone} />
      </div>
      {on ? (
        <span className={cn("figures truncate text-caption font-medium", tint)}>
          ${fmtPrice(price)}
        </span>
      ) : null}
    </div>
  );
}

export function OrderTicket({
  market,
  account,
  order,
  patch,
  mode,
  collapsed,
  onCollapsed,
  className,
}: {
  market: Market;
  account: Account;
  order: Order;
  patch: (next: Partial<Order>) => void;
  mode: Mode;
  collapsed: boolean;
  onCollapsed: (collapsed: boolean) => void;
  className?: string;
}) {
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const pay = Number.parseFloat(order.pay) || 0;
  const entry = entryPrice(order, market);
  const notional = pay * order.leverage;
  const units = entry > 0 ? notional / entry : 0;
  const liquidation = liquidationPrice(order, market);
  const resting = isResting(order);
  const maker = resting || order.postOnly;
  const fee = notional * (maker ? MAKER_FEE : TAKER_FEE);
  const long = order.side === "long";
  const advanced = shows("advancedOrders", mode);

  /** A stop sits the wrong way from entry; a target sits the right way. */
  const exitAt = (kind: "stop" | "target") =>
    entry *
    (long ? (kind === "stop" ? 0.95 : 1.08) : kind === "stop" ? 1.05 : 0.92);

  /** How many advanced settings are away from their default, for the label. */
  const changed = [
    order.triggered,
    order.margin !== "cross",
    order.reduceOnly,
    order.postOnly && resting,
  ].filter(Boolean).length;

  /**
   * Long and short sits in the panel header beside the collapse chevron.
   *
   * It is the first decision on the ticket and the one that colours everything
   * under it, so it reads as the panel's own title — which is exactly what the
   * header row is for, and saves the row a separate title would have cost.
   */
  const direction = (
    <Segmented
      className="min-w-0 flex-1"
      grow
      label="Direction"
      onChange={(side) =>
          patch({
            side,
            // A stop below the price is nonsense once the trade is the other
            // way round, so both exits move with the side rather than being
            // left somewhere they can never be hit.
            stopLoss:
              order.stopLoss === null
                ? null
                : entry * (side === "long" ? 0.95 : 1.05),
          takeProfit:
            order.takeProfit === null
              ? null
              : entry * (side === "long" ? 1.08 : 0.92),
        })
      }
      options={[
        {
          label: (
            <>
              <TrendingUpIcon />
              Long
            </>
          ),
          tone: "up",
          value: "long",
        },
        {
          label: (
            <>
              <TrendingDownIcon />
              Short
            </>
          ),
          tone: "down",
          value: "short",
        },
      ]}
      size="md"
      value={order.side}
    />
  );

  return (
    <CollapsiblePanel
      className={className}
      collapsed={collapsed}
      direction="column"
      header={direction}
      label="Order ticket"
      onCollapsed={onCollapsed}
      title="Ticket"
    >
    {/* 16px between groups on the desk rather than 20. The groups are wide
        blocks with their own internal 8px rhythm, so the extra four pixels
        were not doing separating work — and four of them is a row of the
        exits, which is the difference between the ticket ending above the
        footer and the ticket growing a scrollbar. */}
    <div className="flex min-h-0 flex-1 flex-col gap-5 px-1 pt-4 xl:gap-4 xl:overflow-y-auto">
      <div className="flex flex-col gap-2">
        {/* "Use mark" is a link in the label row, not a button welded to the
            right of the field. As a button it made the input narrower than
            every other input in the ticket and put a second thing to press on
            a row whose job is to hold one number. */}
        <FieldHead
          aside={
            resting ? (
              <Button
                onClick={() =>
                  patch({ limit: market.price.toFixed(priceDp(market.price)) })
                }
                size="xs"
                variant="link"
              >
                Use mark
              </Button>
            ) : undefined
          }
          label="Price"
        />
        <Segmented
          grow
          label="Order type"
          onChange={(base) => patch({ base })}
          options={[
            { value: "market", label: advanced ? "Market" : "At market" },
            { value: "limit", label: advanced ? "Limit" : "At my price" },
          ]}
          value={order.base}
        />

        {resting ? (
          <Amount
            label="Limit price"
            onChange={(limit) => patch({ limit })}
            placeholder={fmtPrice(market.price)}
            size="md"
            suffix={<span className="text-kicker text-fg-subtle">USD</span>}
            value={order.limit}
          />
        ) : null}
      </div>

      {/*
       * What you put in and what you get out, on one line.
       *
       * Two halves of one sentence, and stacked they cost two 82px blocks —
       * which, with the two exits below doing the same thing, is what put the
       * ticket into its own scrollbar on a laptop. Side by side they read as
       * the exchange they are, and the ticket ends above the fold.
       *
       * The shortcuts stay full width underneath rather than moving into the
       * left column: four of them do not fit in half a column, and there is
       * only one field here you can type into, so there is nothing for them to
       * be ambiguous about.
       *
       * DOM order is pay, shortcuts, get — the phone's order, top to bottom.
       * The desk puts "You get" back up on the first row explicitly.
       */}
      <div className="grid gap-2 xl:grid-cols-2 xl:gap-x-3">
        <div className="flex min-w-0 flex-col gap-2 xl:col-start-1 xl:row-start-1">
          <FieldHead
            aside={
              <span className="figures truncate text-caption text-fg-subtle">
                ${usd(advanced ? account.free : account.balance)}{" "}
                {advanced ? "free" : "available"}
              </span>
            }
            label="You pay"
          />
          <Amount
            label="Amount you pay"
            onChange={(value) => patch({ pay: value })}
            suffix={<span className="text-caption text-fg-muted">USDC</span>}
            value={order.pay}
          />
        </div>

        <div className="flex gap-1.5 xl:col-span-2 xl:col-start-1 xl:row-start-2">
          {[0.25, 0.5, 0.75, 1].map((fraction) => (
            <Chip
              key={fraction}
              onClick={() => patch({ pay: (BALANCE * fraction).toFixed(2) })}
            >
              {fraction === 1 ? "Max" : `${fraction * 100}%`}
            </Chip>
          ))}
        </div>

        <div className="flex min-w-0 flex-col gap-2 xl:col-start-2 xl:row-start-1">
          <FieldHead
            aside={
              <span className="figures text-caption text-fg-subtle">
                ${usd(notional)}
              </span>
            }
            label={long ? "You get" : "You sell"}
          />
          <div className="well flex h-14 items-center gap-2 rounded-2xl px-4">
            <span
              className={cn(
                "figures min-w-0 flex-1 truncate text-title",
                units > 0 ? "text-foreground" : "text-fg-subtle",
              )}
            >
              {usd(units, units >= 1 ? 4 : 6)}
            </span>
            <span className="text-caption text-fg-muted">{market.symbol}</span>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <FieldHead
          aside={
            <span className="figures text-caption text-foreground">
              {order.leverage}×
            </span>
          }
          label="Leverage"
        />
        <input
          aria-label="Leverage"
          className="slider"
          max={100}
          min={1}
          onChange={(event) => patch({ leverage: Number(event.target.value) })}
          step={1}
          style={{
            ["--fill" as string]: `${((order.leverage - 1) / 99) * 100}%`,
          }}
          type="range"
          value={order.leverage}
        />
        <Segmented
          grow
          label="Leverage presets"
          onChange={(value) => patch({ leverage: Number(value) })}
          options={LEVERAGE_PRESETS.map((preset) => ({
            label: `${preset}×`,
            value: String(preset),
          }))}
          value={String(order.leverage)}
        />
      </div>

      {/*
       * Both exits on one row.
       *
       * They are one decision with two sides — where this ends if it goes
       * wrong, where it ends if it goes right — so a reader sets them looking
       * at both, and a pair is only legible as a pair when it is one row.
       *
       * The hint is here rather than inside each `Exit`: it was the same
       * sentence printed twice, and it is still true printed once.
       */}
      <div className="flex flex-col gap-3">
        <div className="grid items-start gap-x-3 gap-y-5 xl:grid-cols-2">
          <Exit
            label="Get out at"
            onToggle={(on) => patch({ stopLoss: on ? exitAt("stop") : null })}
            price={order.stopLoss}
            tone="down"
          />

          <Exit
            label="Take profit at"
            onToggle={(on) =>
              patch({ takeProfit: on ? exitAt("target") : null })
            }
            price={order.takeProfit}
            tone="up"
          />
        </div>

        {/* Always on the page, not only once a level exists.
            Two reasons and they happen to be the same reason. The panel
            reserves the height either way — the exits' second lines have to
            land somewhere — so a line that appears and disappears buys nothing
            and moves everything below it. And the sentence is most useful
            before you have touched a switch, when "what does this do" is
            still a live question: it says a line lands on the chart, and that
            you move it there rather than typing it. */}
        <p className="px-1 text-kicker text-fg-subtle">
          {order.stopLoss !== null && order.takeProfit !== null
            ? "Drag them on the chart"
            : order.stopLoss !== null || order.takeProfit !== null
              ? "Drag it on the chart"
              : "Set one and drag it on the chart"}
        </p>
      </div>

      {/*
       * The drawer sits at the foot of the body, not straight under the exits.
       *
       * The ticket is as tall as the three grid rows beside it, and its content
       * is not — so there is slack, and the only question is where it goes.
       * Spread across the gaps it makes the whole ticket loose; left under the
       * last control it is a hole. Here it is the break between the order you
       * are placing and the settings you almost never touch, with Advanced
       * landing against the summary it belongs beside.
       *
       * It also means nothing above it moves when an exit opens: the exits grow
       * down into the slack and Advanced stays where it is.
       */}
      {advanced ? (
        <div className="xl:mt-auto">
        <Disclosure
          label={changed === 0 ? "Advanced" : `Advanced · ${changed} changed`}
          onToggle={setAdvancedOpen}
          open={advancedOpen}
        >
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Flag
                checked={order.triggered}
                hint={
                  order.triggered
                    ? `Becomes a ${orderType(order).replace("-", " ")} order`
                    : undefined
                }
                label="Only when the price reaches"
                onChange={(triggered) => patch({ triggered })}
              />
              {order.triggered ? (
                <Amount
                  label="Trigger price"
                  onChange={(trigger) => patch({ trigger })}
                  placeholder={fmtPrice(market.price)}
                  size="md"
                  suffix={
                    <span className="text-kicker text-fg-subtle">trigger</span>
                  }
                  value={order.trigger}
                />
              ) : null}
            </div>

            <div className="flex flex-col gap-2">
              <FieldHead label="Margin" />
              <Segmented
                grow
                label="Margin mode"
                onChange={(margin) => patch({ margin })}
                options={[
                  { value: "cross", label: "Cross" },
                  { value: "isolated", label: "Isolated" },
                ]}
                value={order.margin}
              />
            </div>

            <div className="flex flex-col gap-2.5">
              <Flag
                checked={order.reduceOnly}
                label="Reduce only"
                onChange={(reduceOnly) => patch({ reduceOnly })}
              />
              {/* A market order crosses the book by definition, so it cannot
                  rest on it. The row stays put and goes quiet rather than
                  vanishing and moving everything under it. */}
              <Flag
                checked={order.postOnly}
                disabled={!resting}
                hint={resting ? undefined : "Needs a limit price"}
                label="Post only"
                onChange={(postOnly) => patch({ postOnly })}
              />
            </div>
          </div>
        </Disclosure>
        </div>
      ) : null}

    </div>

    {/*
     * The footer never scrolls away.
     *
     * The ticket is taller than a laptop screen once both exits are open, and
     * the button at the end of it was below the fold — you had to scroll a
     * form to reach the one control the whole form is for. Body scrolls,
     * footer stays: the side is in the panel header at the top, the button is
     * here at the bottom, and both are on screen whatever is happening in
     * between.
     *
     * The summary comes with it. Those four figures are what you read in the
     * half-second before pressing, so they belong beside the thing you press,
     * not a scroll away from it.
     */}
    <div className="relative flex flex-col gap-2.5 px-1 pt-3">
      {/* Says "this continues above" without a hairline: the content fades
          into the panel fill as it passes under. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 -top-4 hidden h-4 bg-gradient-to-b from-transparent to-card xl:block"
      />

      {/* The consequences, on their own surface. These are the numbers worth
          reading back before pressing the button, and the only ones in the
          ticket you do not set. */}
      <div className="well flex flex-col gap-2 rounded-2xl p-4">
        <Stat label="Entry price" value={`$${fmtPrice(entry)}`} />
        {/* Deliberately not "the most you can lose: $X". That line is the
            landing's replacement for the word liquidation, and it is still
            blocked on whether a loss here can exceed the deposit — see
            CONTENT.md. Printing a cap we have not confirmed is worse than
            printing the price the position ends at. */}
        <Stat
          label="Wiped out at"
          tone="text-warning"
          value={notional > 0 ? `$${fmtPrice(liquidation)}` : "—"}
        />
        {advanced ? (
          <Stat label="Margin used" value={pay > 0 ? `$${usd(pay)}` : "—"} />
        ) : null}
        <Stat
          label={advanced ? (maker ? "Fee (maker)" : "Fee (taker)") : "Fee"}
          value={`$${usd(fee)}`}
        />
      </div>

      {/* The one action colour on the screen, and it is the landing's
            near-black. Which way you are going is already said by the tinted
            control at the top of this ticket and by the word in the button, so
            a green button would restate it and spend a colour that otherwise
            only ever means "the price moved". */}
      <Button className="w-full rounded-full" disabled={pay <= 0} size="xl">
        {pay <= 0
          ? "Enter an amount"
          : `${long ? "Long" : "Short"} ${market.name}`}
      </Button>
      <p className="text-center text-caption text-fg-subtle">
        Interface preview. Nothing is placed.
      </p>
    </div>
    </CollapsiblePanel>
  );
}
