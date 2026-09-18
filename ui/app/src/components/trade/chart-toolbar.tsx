"use client";

import {
  ChartAreaIcon,
  ChartCandlestickIcon,
  ChartColumnIcon,
  ChartLineIcon,
  ScalingIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import type { ChartKind, Overlay, Study } from "./chart";
import { Segmented } from "./controls";
import { TIMEFRAMES, type Timeframe } from "./market";
import { type Mode, shows } from "./mode";

/**
 * Everything above the chart.
 *
 * Three groups, left to right: when (timeframe), how (series type), and what
 * else is drawn on it (overlays and studies). They are separated by space
 * rather than by rules, and the third group wraps to its own line before the
 * first two do, because a reader changes the timeframe fifty times for every
 * once they turn on MACD.
 *
 * The study toggles are `Button`s and not a `Segmented`: several can be on at
 * once, and a segmented control that allows multiple selections is a row of
 * checkboxes wearing the wrong clothes.
 */

const KINDS: { value: ChartKind; label: React.ReactNode }[] = [
  { value: "candles", label: <ChartCandlestickIcon /> },
  { value: "bars", label: <ChartColumnIcon /> },
  { value: "line", label: <ChartLineIcon /> },
  { value: "area", label: <ChartAreaIcon /> },
];

const OVERLAYS: { value: Overlay; label: string }[] = [
  { value: "ma", label: "EMA" },
  { value: "bollinger", label: "Bands" },
];

const STUDIES: { value: Study; label: string }[] = [
  { value: "volume", label: "Volume" },
  { value: "rsi", label: "RSI" },
  { value: "macd", label: "MACD" },
];

export function ChartToolbar({
  timeframe,
  onTimeframe,
  kind,
  onKind,
  overlays,
  onOverlays,
  studies,
  onStudies,
  logScale,
  onLogScale,
  onFit,
  mode,
  className,
}: {
  timeframe: Timeframe;
  onTimeframe: (value: Timeframe) => void;
  kind: ChartKind;
  onKind: (value: ChartKind) => void;
  overlays: Overlay[];
  onOverlays: (value: Overlay[]) => void;
  studies: Study[];
  onStudies: (value: Study[]) => void;
  logScale: boolean;
  onLogScale: (value: boolean) => void;
  onFit: () => void;
  mode: Mode;
  className?: string;
}) {
  return (
    // One scrolling row on a phone, wrapping only once there is room to wrap
    // into. Wrapped, this is three rows and 120px of chrome above a 320px
    // chart — more toolbar than chart, on the screen with the least of both.
    <div
      className={cn(
        "flex items-center gap-x-3 gap-y-2 overflow-x-auto lg:flex-wrap lg:overflow-visible",
        className,
      )}
    >
      {shows("timeframes", mode) ? (
        <Segmented
          className="shrink-0"
          label="Timeframe"
          onChange={onTimeframe}
          options={TIMEFRAMES.map((tf) => ({ value: tf, label: tf }))}
          value={timeframe}
        />
      ) : null}

      {/* Everything past the timeframe is pro. A reader who has never traded
          does not want to be asked whether they would like Bollinger bands. */}
      {shows("studies", mode) ? (
        <Segmented
          className="shrink-0"
          label="Chart type"
          onChange={onKind}
          options={KINDS}
          value={kind}
        />
      ) : null}

      <div
        className={cn(
          "flex items-center gap-1 lg:ml-auto lg:flex-wrap",
          !shows("studies", mode) && "hidden",
        )}
      >
        {/* coss/ui toggle groups: several can be on at once, which is what
            separates these from the segmented controls to their left. */}
        <ToggleGroup
          aria-label="Overlays"
          className="gap-1"
          onValueChange={(next) => onOverlays(next as Overlay[])}
          size="sm"
          multiple
          value={overlays}
        >
          {OVERLAYS.map((overlay) => (
            <ToggleGroupItem
              className="rounded-full text-kicker data-pressed:bg-secondary"
              key={overlay.value}
              value={overlay.value}
            >
              {overlay.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>

        <span aria-hidden="true" className="mx-1 h-4 w-px bg-hairline" />

        <ToggleGroup
          aria-label="Studies"
          className="gap-1"
          onValueChange={(next) => onStudies(next as Study[])}
          size="sm"
          multiple
          value={studies}
        >
          {STUDIES.map((study) => (
            <ToggleGroupItem
              className="rounded-full text-kicker data-pressed:bg-secondary"
              key={study.value}
              value={study.value}
            >
              {study.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>

        <span aria-hidden="true" className="mx-1 h-4 w-px bg-hairline" />

        <Toggle
          className="rounded-full text-kicker data-pressed:bg-secondary"
          onPressedChange={(next) => onLogScale(next)}
          pressed={logScale}
          size="sm"
        >
          Log
        </Toggle>
        <Button
          aria-label="Fit the chart to the data"
          className="rounded-full"
          onClick={onFit}
          size="icon-xs"
          variant="ghost"
        >
          <ScalingIcon />
        </Button>
      </div>
    </div>
  );
}
