"use client";

import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTab } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

/** Small shared pieces. Everything here is a coss component with a job. */

type Tone = "default" | "up" | "down";

export type Segment<T extends string> = {
  value: T;
  label: ReactNode;
  tone?: Tone;
};

/**
 * coss items run two pixels taller than the Button of the same size; pinning them shorter lines the
 * track up: sm 28, default 32, lg 36.
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
