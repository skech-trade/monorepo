"use client";

import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * A panel that folds against the edge it lives on.
 *
 * Nobody uses the whole screen. A scalper watches the tape and never opens the
 * positions list; someone holding a position for a week wants the chart as
 * wide as it goes and no book at all. Rather than guess, every region folds,
 * and the fold is the same gesture everywhere: a chevron pointing at the space
 * the panel will leave behind.
 *
 * The chevron shares a row with whatever control the panel already had at its
 * top — "Book | Trades ›", "Long | Short ›" — rather than sitting under a title
 * of its own. A separate title row was a whole line of chrome restating the
 * word already written on the tab beside it, on three panels, on every screen.
 *
 * Collapsed, a column becomes a 44px rail with its name set vertically: still
 * visible, still labelled, one click from coming back. It does not vanish,
 * because a panel that disappears entirely leaves a reader no way to know it
 * was ever there. A row folds to just its header, which keeps its tabs live —
 * you can still change which list is waiting behind it.
 */

/**
 * The chevron on its own, for a panel that is one row tall and folds sideways
 * within that row rather than into it — the market header, whose fold hides
 * the 24h figures beside the price and must not cost the row any height.
 */
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
          <button
            aria-expanded={!collapsed}
            aria-label={words}
            className={cn(
              "flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-fg-subtle transition-colors duration-micro ease-smooth-out hover:bg-surface-2 hover:text-foreground",
              className,
            )}
            onClick={() => onCollapsed(!collapsed)}
            type="button"
          />
        }
      >
        <Chevron className="size-4" />
      </TooltipTrigger>
      <TooltipPopup>{words}</TooltipPopup>
    </Tooltip>
  );
}

export function CollapsiblePanel({
  title,
  header,
  collapsed,
  onCollapsed,
  direction,
  children,
  className,
  label,
}: {
  /** The name on the collapsed rail, and the fallback header when there is no
      control to put there. */
  title: string;
  /** The panel's own top control — a tab strip, usually. Shares the header. */
  header?: ReactNode;
  collapsed: boolean;
  onCollapsed: (collapsed: boolean) => void;
  /** `column` folds sideways into a rail; `row` folds up into its header. */
  direction: "column" | "row";
  children: ReactNode;
  className?: string;
  /** Names the region for a screen reader. Defaults to the title. */
  label?: string;
}) {
  const toggle = (
    <FoldButton
      collapsed={collapsed}
      direction={direction}
      onCollapsed={onCollapsed}
      title={title}
    />
  );

  if (collapsed && direction === "column") {
    return (
      <aside
        aria-label={label ?? title}
        className={cn(
          "panel flex flex-col items-center gap-3 rounded-4xl py-2",
          className,
        )}
      >
        {toggle}
        {/* Bottom-to-top, so the word reads upward from the chevron rather
            than upside down from the floor of the panel. */}
        <span
          className="whitespace-nowrap text-kicker text-fg-subtle"
          style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
        >
          {title}
        </span>
      </aside>
    );
  }

  /**
   * A row's chevron goes in the corner; a column's stays on the header line.
   *
   * A row panel is the full width of the page, so inline the chevron lands
   * wherever the tab strip happens to end — a couple of hundred pixels adrift
   * of the panel edge, and at a different height from the one on the panel
   * above it. A column is 240px wide, where the end of the header line *is*
   * the top right corner.
   */
  const inCorner = direction === "row";

  return (
    <section
      aria-label={label ?? title}
      className={cn(
        "panel flex min-w-0 flex-col rounded-4xl p-2",
        inCorner && "relative pr-12",
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-1">
        {header ?? (
          <h2 className="flex-1 truncate px-2 text-kicker text-fg-subtle">
            {title}
          </h2>
        )}
        {inCorner ? null : toggle}
      </div>
      {inCorner ? (
        <span className="absolute top-2 right-2">{toggle}</span>
      ) : null}
      {collapsed ? null : children}
    </section>
  );
}
