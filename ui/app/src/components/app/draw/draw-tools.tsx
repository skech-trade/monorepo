"use client";

import { EraserIcon, ShapesIcon, Undo2Icon, WaypointsIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { legPath } from "@/lib/sketch";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@/components/ui/menu";
import { ChartSettingsButton } from "../settings";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";

/** Points: a click per turn, every point a handle. Shapes: eight common calls, one press each. */

export type Preset =
  | "dip-rip"
  | "straight-up"
  | "slow-climb"
  | "rip-pullback"
  | "spike-hold"
  | "double-dip"
  | "pump-fade"
  | "bleed";

/**
 * Eight common calls. The numbers are the line, as fractions of the chart's
 * height above (+) or below (-) where you start; the thumbnail and the drawn
 * line are the same numbers, so what you see is what you get.
 */
export const PRESETS: { value: Preset; label: string; hint: string; shape: number[] }[] = [
  { value: "dip-rip", label: "Dip, then run", hint: "Down a little, then up past the start.", shape: [0, -0.3, -0.6, -0.7, -0.45, 0, 0.5, 0.95, 1.25, 1.45] },
  { value: "straight-up", label: "Straight up", hint: "No dip. The whole stake is on the table.", shape: [0, 0.15, 0.3, 0.45, 0.6, 0.75, 0.9, 1.05, 1.2, 1.35] },
  { value: "slow-climb", label: "Slow climb", hint: "Up, gently, with small steps back.", shape: [0, 0.12, 0.08, 0.25, 0.2, 0.4, 0.34, 0.55, 0.5, 0.7] },
  { value: "rip-pullback", label: "Rip, then pull back", hint: "Fast up, gives some back, holds higher.", shape: [0, 0.5, 0.95, 1.3, 1.4, 1.15, 0.9, 0.85, 0.95, 1.0] },
  { value: "spike-hold", label: "Spike and hold", hint: "One move, then flat at the new level.", shape: [0, 0.2, 0.9, 1.2, 1.25, 1.22, 1.25, 1.23, 1.26, 1.25] },
  { value: "double-dip", label: "Double dip", hint: "Down twice, then up.", shape: [0, -0.5, -0.7, -0.3, -0.6, -0.75, -0.35, 0.2, 0.7, 1.0] },
  { value: "pump-fade", label: "Pump, then fade", hint: "Up first, then down below where you started.", shape: [0, 0.5, 0.8, 0.7, 0.3, -0.1, -0.5, -0.8, -1.0, -1.15] },
  { value: "bleed", label: "Slow bleed", hint: "Drifts down and keeps going.", shape: [0, -0.2, -0.35, -0.55, -0.7, -0.9, -1.0, -1.15, -1.25, -1.4] },
];

/** The shape, large enough to read at a glance. A dashed rule marks the start. */
/** The little picture of a preset. Shared with the phone drawer. */
export function Thumb({ shape }: { shape: number[] }) {
  const W = 160;
  const H = 72;
  const lo = Math.min(0, ...shape);
  const hi = Math.max(0, ...shape);
  const y = (v: number) => 10 + ((hi - v) / (hi - lo || 1)) * (H - 20);
  const pts = shape.map((v, i) => ({ x: 8 + (i / (shape.length - 1)) * (W - 16), y: y(v) }));
  const head = pts[pts.length - 1];
  return (
    // A span carries the size: the menu item sizes any bare svg as an icon.
    <span className="block w-full overflow-hidden rounded-lg border bg-muted/40">
      <svg aria-hidden="true" className="block size-full" preserveAspectRatio="none" viewBox={`0 0 ${W} ${H}`}>
        <line stroke="var(--muted-foreground)" strokeDasharray="3 4" strokeOpacity="0.6" x1="0" x2={W} y1={y(0)} y2={y(0)} />
        <circle cx={pts[0].x} cy={pts[0].y} fill="var(--muted-foreground)" r="3" />
        <path d={legPath(pts)} fill="none" stroke="var(--brand)" strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" />
        <circle cx={head.x} cy={head.y} fill="var(--brand)" r="4" />
      </svg>
    </span>
  );
}

function Tip({ words, children }: { words: string; children: React.ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipPopup>{words}</TooltipPopup>
    </Tooltip>
  );
}

export function DrawTools({
  canUndo,
  onUndo,
  onClear,
  onPreset,
  drawing = true,
}: {
  canUndo: boolean;
  onUndo: () => void;
  onClear: () => void;
  onPreset: (preset: Preset) => void;
  /**
   * Whether the line is still yours to change.
   *
   * While a round runs it is not: there is nothing to undo, clearing it would
   * not close the position, and a shape would replace a line that is already
   * being traded. The rail used to disappear whole at that point and took the
   * chart settings with it, so the one moment you might want to change how the
   * chart is drawn was the one moment you could not.
   */
  drawing?: boolean;
}) {
  if (!drawing) {
    return (
      <div className="flex shrink-0 flex-row items-center gap-1 self-start rounded-2xl border bg-card p-1 sm:flex-col sm:gap-1.5 sm:p-1.5 [&_svg]:size-4 sm:[&_svg]:size-5">
        <ChartSettingsButton className="size-8 rounded-lg sm:size-10 sm:rounded-xl" />
      </div>
    );
  }

  return (
    /* A rail beside the chart, the height of what it acts on; a row on a phone. */
    <div className="flex shrink-0 flex-row items-center gap-1 self-start rounded-2xl border bg-card p-1 sm:flex-col sm:gap-1.5 sm:p-1.5 [&_svg]:size-4 sm:[&_svg]:size-5">
      {/* One tool, shown not chosen. The pen rounded corners, and a corner is a close and an open. */}
      <Tip words="Click to place a point, or drag to draw. Drag a point to move it, double-click to remove it.">
        <span className="flex size-8 items-center justify-center rounded-lg bg-accent text-foreground sm:size-10 sm:rounded-xl">
          <WaypointsIcon />
        </span>
      </Tip>

      {/* Turns with the rail. */}
      <span aria-hidden="true" className="mx-0.5 h-6 w-px shrink-0 bg-border sm:mx-0 sm:my-0.5 sm:h-px sm:w-6" />

      <Tip words="Undo the last stroke">
        <Button aria-label="Undo" className="size-8 rounded-lg sm:size-10 sm:rounded-xl" disabled={!canUndo} onClick={onUndo} variant="ghost">
          <Undo2Icon />
        </Button>
      </Tip>
      <Tip words="Clear the line">
        <Button aria-label="Clear" className="size-8 rounded-lg sm:size-10 sm:rounded-xl" disabled={!canUndo} onClick={onClear} variant="ghost">
          <EraserIcon />
        </Button>
      </Tip>

      {/* Beside the tools, because how the chart is drawn is a tool too. */}
      <ChartSettingsButton className="size-8 rounded-lg sm:size-10 sm:rounded-xl" />

      <Menu>
        <MenuTrigger render={<Button aria-label="Shapes" className="size-8 rounded-lg sm:size-10 sm:rounded-xl" variant="ghost" />}>
          <ShapesIcon />
        </MenuTrigger>
        {/* Forty rem does not exist on a phone, and neither does the room to
            the right of a rail that is sitting at the left edge of one. */}
        <MenuPopup align="start" className="w-[min(40rem,calc(100vw-6rem))] p-2" side="right" sideOffset={8}>
          <div className="grid grid-cols-2 gap-1 sm:grid-cols-4">
            {PRESETS.map((p) => (
              <MenuItem className="h-auto flex-col items-stretch gap-2 rounded-xl p-2 [&>span:first-child]:aspect-[20/9]" key={p.value} onClick={() => onPreset(p.value)}>
                <Thumb shape={p.shape} />
                <span className="flex min-w-0 flex-col gap-0.5 px-0.5">
                  <span className="font-medium">{p.label}</span>
                  <span className="text-muted-foreground text-xs leading-snug">{p.hint}</span>
                </span>
              </MenuItem>
            ))}
          </div>
        </MenuPopup>
      </Menu>
    </div>
  );
}
