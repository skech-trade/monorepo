"use client";

import { ChevronDownIcon } from "lucide-react";
import type { ReactNode } from "react";
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

/** The landing's --up and --down at an alpha. No -dim token of our own. */
const THUMB: Record<SegmentTone, string> = {
  default: "bg-thumb text-foreground shadow-card",
  up: "bg-up/10 text-up",
  down: "bg-down/10 text-down",
};

export type Segment<T extends string> = {
  value: T;
  label: ReactNode;
  /** Tints the thumb when this segment is the selected one. */
  tone?: SegmentTone;
};

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
  return (
    <div
      aria-label={label}
      className={cn(
        "well inline-flex items-center gap-1 rounded-full p-1",
        grow && "flex w-full",
        className,
      )}
      role="tablist"
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            aria-selected={selected}
            className={cn(
              "flex items-center justify-center gap-1.5 rounded-full transition-[background,color,box-shadow] duration-micro ease-smooth-out [&_svg]:shrink-0",
              size === "sm"
                ? "h-8 px-3 text-kicker [&_svg]:size-3.5"
                : "h-11 px-4 font-semibold text-[0.9375rem] tracking-[-0.012em] [&_svg]:size-4",
              grow && "flex-1",
              selected
                ? THUMB[option.tone ?? "default"]
                : "text-fg-subtle hover:text-foreground",
            )}
            key={option.value}
            onClick={() => onChange(option.value)}
            role="tab"
            type="button"
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * On or off, for the one setting on this screen that is genuinely binary.
 *
 * `role="switch"` rather than a checkbox: a checkbox is a thing you are
 * selecting, a switch is a thing you are turning on, and a screen reader says
 * so differently. The track takes the tone of what it turns on, so the switch
 * under "get out at" is the same red as the rule it draws on the chart.
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
    <button
      aria-checked={checked}
      aria-label={label}
      className={cn(
        "relative h-[1.625rem] w-11 shrink-0 cursor-pointer rounded-full transition-colors duration-micro ease-smooth-out",
        !checked && "bg-surface-3",
        checked && tone === "down" && "bg-down",
        checked && tone === "up" && "bg-up",
        checked && tone === "default" && "bg-brand",
      )}
      onClick={() => onChange(!checked)}
      role="switch"
      type="button"
    >
      <span
        className={cn(
          "absolute top-0.5 left-0.5 size-[1.375rem] rounded-full bg-thumb shadow-card transition-transform duration-micro ease-smooth-out",
          checked && "translate-x-[1.125rem]",
        )}
      />
    </button>
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

/** A soft chip. Reads, never presses — for a side on a row or a change on a
    price. Anything you can press is a `Button`. */
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
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-1 text-kicker",
        tone === "up" && "bg-up/10 text-up",
        tone === "down" && "bg-down/10 text-down",
        tone === "default" && "well text-fg-muted",
        className,
      )}
    >
      {children}
    </span>
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
 *
 * 56px, the height of the ticket's own fields. It is the last thing above the
 * summary and the button, and at 44px it read as a footnote to the ticket
 * rather than a part of it.
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
        className="well flex h-14 w-full items-center justify-between gap-3 rounded-2xl px-4 text-kicker text-fg-muted transition-colors duration-micro ease-smooth-out hover:bg-surface-3 hover:text-foreground"
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
