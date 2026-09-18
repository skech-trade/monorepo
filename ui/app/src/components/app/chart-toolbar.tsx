"use client";

import {
  ChartAreaIcon,
  ChartCandlestickIcon,
  ChartColumnIcon,
  ChartLineIcon,
  ScalingIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Toggle } from "@/components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { TIMEFRAMES, type Timeframe } from "@/lib/market";
import { cn } from "@/lib/utils";
import type { ChartKind, Overlay, Study } from "./chart";
import { Segmented } from "./controls";

const KINDS = [
  { value: "candles", label: <ChartCandlestickIcon /> },
  { value: "bars", label: <ChartColumnIcon /> },
  { value: "line", label: <ChartLineIcon /> },
  { value: "area", label: <ChartAreaIcon /> },
] satisfies { value: ChartKind; label: React.ReactNode }[];

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
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      <Segmented
        label="Timeframe"
        onChange={onTimeframe}
        options={TIMEFRAMES.map((tf) => ({ value: tf, label: tf }))}
        size="sm"
        value={timeframe}
      />
      <Segmented label="Chart type" onChange={onKind} options={KINDS} size="sm" value={kind} />

      <div className="ml-auto flex items-center gap-1">
        <ToggleGroup aria-label="Overlays" multiple onValueChange={(v) => onOverlays(v as Overlay[])} size="sm" value={overlays}>
          {OVERLAYS.map((o) => (
            <ToggleGroupItem className="text-xs" key={o.value} value={o.value}>
              {o.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <Separator className="mx-1 h-4" orientation="vertical" />
        <ToggleGroup aria-label="Studies" multiple onValueChange={(v) => onStudies(v as Study[])} size="sm" value={studies}>
          {STUDIES.map((s) => (
            <ToggleGroupItem className="text-xs" key={s.value} value={s.value}>
              {s.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <Separator className="mx-1 h-4" orientation="vertical" />
        <Toggle className="text-xs" onPressedChange={onLogScale} pressed={logScale} size="sm">
          Log
        </Toggle>
        <Tooltip>
          <TooltipTrigger render={<Button aria-label="Fit the chart to the data" onClick={onFit} size="icon-sm" variant="ghost" />}>
            <ScalingIcon />
          </TooltipTrigger>
          <TooltipPopup>Fit to data</TooltipPopup>
        </Tooltip>
      </div>
    </div>
  );
}
