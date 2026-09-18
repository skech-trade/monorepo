"use client";

import { ChevronDownIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Switch as CossSwitch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTab } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

/**
 * The one control this screen is mostly made of.
 *
 * Long/short, market/limit and the timeframe row are all the same gesture —
 * pick one of a few — and xStream draws each of them differently: underlined
 * tabs, a pill group, bare text buttons. Three drawings for one meaning is
 * three things to learn. This is the drawing.
 *
 * A recessed track with a raised thumb, both fully rounded, which is the shape
 * every reader already knows from their phone. `--thumb` flips direction with
 * the theme so the selected segment always reads as the one nearer the light.
 *
 * Not built on `Button`, deliberately: these are `role="tab"`, one of a set,
 * and a `Button` here would bring its own border, ring and press shadow into a
 * control whose whole job is to look like one continuous track.
 */

export type SegmentTone = "default" | "up" | "down";

/** The landing's --up and --down at an alpha, on the sliding thumb. */
const THUMB: Record<SegmentTone, string> = {
  default:
    "[&>[data-slot=tab-indicator]]:bg-thumb [&>[data-slot=tab-indicator]]:shadow-card",
  up: "[&>[data-slot=tab-indicator]]:bg-up/10 [&>[data-slot=tab-indicator]]:shadow-none",
  down: "[&>[data-slot=tab-indicator]]:bg-down/10 [&>[data-slot=tab-indicator]]:shadow-none",
};

export type Segment<T extends string> = {
  value: T;
  label: ReactNode;
  /** Tints the thumb when this segment is the selected one. */
  tone?: SegmentTone;
};

/**
 * coss/ui's Tabs underneath, so the thumb slides between segments rather
 * than blinking from one to the next. The pill shape is ours: the track is
 * fully rounded and the indicator inherits it.
 */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  className,
  size = "sm",
  grow = false,
}: {
  value: T;
  onChange: (value: T) => void;
  options: Segment<T>[];
  /** Names the group for a screen reader. Required: a row of bare words is
      unnavigable without it. */
  label: string;
  className?: string;
  size?: "sm" | "md";
  /** Segments share the width equally. For two-up choices like long/short. */
  grow?: boolean;
}) {
  const tone = options.find((o) => o.value === value)?.tone ?? "default";
  return (
    <Tabs
      className={cn("gap-0", grow && "w-full")}
      onValueChange={(next) => onChange(next as T)}
      value={value}
    >
      <TabsList
        aria-label={label}
        className={cn(
          "well rounded-full p-1 text-fg-subtle",
          grow && "w-full",
          THUMB[tone],
          className,
        )}
      >
        {options.map((option) => (
          <TabsTab
            className={cn(
              "rounded-full text-fg-subtle hover:text-foreground data-active:text-foreground [&_svg]:shrink-0",
              size === "sm"
                ? "h-8 px-3 text-kicker sm:h-8 [&_svg]:size-3.5 sm:[&_svg]:size-3.5"
                : "h-11 px-4 font-semibold text-[0.9375rem] tracking-[-0.012em] sm:h-11 sm:text-[0.9375rem] [&_svg]:size-4 sm:[&_svg]:size-4",
              !grow && "grow-0",
              option.tone === "up" && "data-active:text-up",
              option.tone === "down" && "data-active:text-down",
            )}
            key={option.value}
            value={option.value}
          >
            {option.label}
          </TabsTab>
        ))}
      </TabsList>
    </Tabs>
  );
}

/**
 * On or off, for the one setting on this screen that is genuinely binary.
 *
 * coss/ui's Switch. The track takes the tone of what it turns on, so the
 * switch under "get out at" is the same red as the rule it draws on the chart.
 */
export function Switch({
  checked,
  onChange,
  label,
  tone = "default",
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  /** Matches whatever the switch turns on, so the control and the thing it
      draws on the chart are the same colour. */
  tone?: "default" | "up" | "down";
}) {
  return (
    <CossSwitch
      aria-label={label}
      checked={checked}
      className={cn(
        "data-unchecked:bg-surface-3",
        tone === "default" && "data-checked:bg-brand",
        tone === "up" && "data-checked:bg-up",
        tone === "down" && "data-checked:bg-down",
      )}
      onCheckedChange={(next) => onChange(next)}
    />
  );
}

/**
 * A label and a figure on one line, for the summary rail under the ticket.
 *
 * `tone` carries direction, so the caller decides whether a number is good
 * news; the row only decides how a number is set.
 */
export function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: ReactNode;
  tone?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-caption text-fg-subtle">{label}</span>
      <span className={cn("figures text-caption", tone ?? "text-foreground")}>
        {value}
      </span>
    </div>
  );
}

/** A soft chip. Reads, never presses, for a side on a row or a change on a
    price. coss/ui's Badge in the pill shape. Anything you can press is a
    `Button`. */
export function Pill({
  children,
  tone = "default",
  className,
}: {
  children: ReactNode;
  tone?: "default" | "up" | "down";
  className?: string;
}) {
  return (
    <Badge
      className={cn(
        "h-auto rounded-full px-2.5 py-1 font-semibold text-kicker sm:text-kicker",
        tone === "up" && "bg-up/10 text-up",
        tone === "down" && "bg-down/10 text-down",
        tone === "default" && "well text-fg-muted",
        className,
      )}
      size="lg"
      variant={tone === "up" ? "success" : tone === "down" ? "error" : "secondary"}
    >
      {children}
    </Badge>
  );
}

/**
 * A section that folds away.
 *
 * For the controls that are real but rare. A ticket that shows every execution
 * flag at once reads as a settings page, and the reader has to decide about
 * cross-vs-isolated margin before they are allowed to feel they have finished —
 * even though the answer is the same every time for almost everyone.
 *
 * Closed it is one row and one word; open it is the whole set. The state is not
 * remembered between visits on purpose: the closed state is the recommendation,
 * and a ticket that silently reopens six switches because you looked at them
 * once is a ticket that grows over time.
 */
export function Disclosure({
  label,
  open,
  onToggle,
  children,
}: {
  label: string;
  open: boolean;
  onToggle: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4">
      <button
        aria-expanded={open}
        className="well flex h-11 w-full items-center justify-between gap-3 rounded-2xl px-4 text-kicker text-fg-muted transition-colors duration-micro ease-smooth-out hover:bg-surface-3 hover:text-foreground"
        onClick={() => onToggle(!open)}
        type="button"
      >
        {label}
        <ChevronDownIcon
          className={cn(
            "size-4 shrink-0 transition-transform duration-quick ease-smooth-out",
            open && "rotate-180",
          )}
        />
      </button>
      {open ? children : null}
    </div>
  );
}
