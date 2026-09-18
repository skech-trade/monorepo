"use client";

import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTab } from "@/components/ui/tabs";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** Small shared pieces. Everything here is a coss component with a job. */

export type Tone = "default" | "up" | "down";

export type Segment<T extends string> = {
  value: T;
  label: ReactNode;
  tone?: Tone;
};

/**
 * coss sizes a segmented track off its items, and an item runs two pixels
 * taller than a Button of the same name — so a segmented control never lines
 * up with the button next to it. Pinning the item two pixels shorter makes the
 * track come out at the Button height: sm 28, default 32, lg 36.
 */
const SEGMENT_HEIGHTS: Record<"sm" | "default" | "lg", string> = {
  default: "[&_[data-slot=tabs-tab]]:h-8 sm:[&_[data-slot=tabs-tab]]:h-7",
  lg: "[&_[data-slot=tabs-tab]]:h-9 sm:[&_[data-slot=tabs-tab]]:h-8",
  sm: "[&_[data-slot=tabs-tab]]:h-7 sm:[&_[data-slot=tabs-tab]]:h-6",
};

/** Pick one of a few. coss Tabs, so the thumb slides. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  className,
  size = "default",
  grow = false,
}: {
  value: T;
  onChange: (value: T) => void;
  options: Segment<T>[];
  label: string;
  className?: string;
  size?: "sm" | "default" | "lg";
  grow?: boolean;
}) {
  const tone = options.find((o) => o.value === value)?.tone ?? "default";
  return (
    <Tabs className={cn("gap-0", grow && "w-full")} onValueChange={(v) => onChange(v as T)} value={value}>
      <TabsList
        aria-label={label}
        className={cn(
          SEGMENT_HEIGHTS[size],
          grow && "w-full",
          tone === "up" && "[&>[data-slot=tab-indicator]]:bg-success/12",
          tone === "down" && "[&>[data-slot=tab-indicator]]:bg-destructive/12",
          className,
        )}
        size={size}
      >
        {options.map((o) => (
          <TabsTab
            className={cn(
              !grow && "grow-0",
              o.tone === "up" && "data-active:text-up",
              o.tone === "down" && "data-active:text-down",
            )}
            key={o.value}
            value={o.value}
          >
            {o.label}
          </TabsTab>
        ))}
      </TabsList>
    </Tabs>
  );
}

/** A soft chip that reads and never presses. */
export function Pill({
  children,
  tone = "default",
  className,
}: {
  children: ReactNode;
  tone?: Tone;
  className?: string;
}) {
  return (
    <Badge
      className={className}
      variant={tone === "up" ? "success" : tone === "down" ? "error" : "secondary"}
    >
      {children}
    </Badge>
  );
}

/** A label and a figure on one line. */
export function Stat({
  label,
  value,
  tone,
  className,
}: {
  label: string;
  value: ReactNode;
  tone?: string;
  className?: string;
}) {
  return (
    <div className={cn("flex items-baseline justify-between gap-4 text-sm", className)}>
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("figures", tone ?? "text-foreground")}>{value}</span>
    </div>
  );
}

/** A figure with its label under it. */
export function Figure({
  label,
  value,
  tone,
  size = "sm",
}: {
  label: string;
  value: ReactNode;
  tone?: string;
  size?: "sm" | "lg";
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className={cn("figures truncate", size === "lg" ? "font-semibold text-2xl" : "text-sm", tone)}>
        {value}
      </span>
      <span className="truncate text-muted-foreground text-xs">{label}</span>
    </div>
  );
}

export function FoldButton({
  collapsed,
  onCollapsed,
  title,
  direction = "row",
  className,
}: {
  collapsed: boolean;
  onCollapsed: (collapsed: boolean) => void;
  title: string;
  direction?: "column" | "row";
  className?: string;
}) {
  const Chevron = collapsed
    ? direction === "column"
      ? ChevronLeftIcon
      : ChevronDownIcon
    : direction === "column"
      ? ChevronRightIcon
      : ChevronUpIcon;
  const words = `${collapsed ? "Show" : "Hide"} ${title.toLowerCase()}`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-expanded={!collapsed}
            aria-label={words}
            className={className}
            onClick={() => onCollapsed(!collapsed)}
            size="icon-xs"
            variant="ghost"
          />
        }
      >
        <Chevron />
      </TooltipTrigger>
      <TooltipPopup>{words}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * A panel of the desk. A coss Card with a one-row header that holds the
 * panel's own control and the fold chevron. Folded sideways it is a rail
 * with its name set vertically; folded up it keeps only the header.
 *
 * The header is eleven deep so the pill inside it clears the card's corner by
 * about as much as it clears the sides. A 2xl corner is 18px of curve, and a
 * pill set three pixels below it and eight in from the edge reads as squeezed
 * out of the corner rather than sitting in it.
 */
export function Pane({
  title,
  header,
  collapsed = false,
  onCollapsed,
  direction = "row",
  children,
  className,
  bodyClassName,
  label,
}: {
  title: string;
  header?: ReactNode;
  collapsed?: boolean;
  onCollapsed?: (collapsed: boolean) => void;
  direction?: "column" | "row";
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  label?: string;
}) {
  if (collapsed && direction === "column" && onCollapsed) {
    return (
      <aside aria-label={label ?? title} className={cn("flex flex-col items-center gap-3 rounded-2xl border bg-background py-2", className)}>
        <FoldButton collapsed direction="column" onCollapsed={onCollapsed} title={title} />
        <span
          className="whitespace-nowrap text-muted-foreground text-xs"
          style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
        >
          {title}
        </span>
      </aside>
    );
  }
  return (
    <section aria-label={label ?? title} className={cn("flex min-w-0 flex-col overflow-hidden rounded-2xl border bg-background", className)}>
      <div className="flex h-11 min-w-0 shrink-0 items-center gap-2 px-2">
        {header ?? <h2 className="flex-1 truncate px-1 font-medium text-sm">{title}</h2>}
        {onCollapsed ? (
          <FoldButton
            className="ml-auto shrink-0"
            collapsed={collapsed}
            direction={direction}
            onCollapsed={onCollapsed}
            title={title}
          />
        ) : null}
      </div>
      {collapsed ? null : <div className={cn("min-h-0 flex-1", bodyClassName)}>{children}</div>}
    </section>
  );
}
