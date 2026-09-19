"use client";

import { EraserIcon, ShapesIcon, Undo2Icon, WaypointsIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { legPath } from "@/lib/sketch";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@/components/ui/menu";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * One way to put a line down, and two ways to take it back.
 *
 * Points is a click per turn: every point is a handle you can move or remove,
 * before and while it plays out. Shapes are eight common calls, one press each.
 */

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
function Thumb({ shape }: { shape: number[] }) {
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
}: {
  canUndo: boolean;
  onUndo: () => void;
  onClear: () => void;
  onPreset: (preset: Preset) => void;
}) {
  return (
    /*
      A rail down the side of the chart, not a row across the header.

      Tools belong beside the thing they act on, and the thing they act on is
      the whole height of the chart. In the header they sat a screen's width
      from the line, sharing a row with the price — which is a reading, not a
      control.
    */
    <div className="flex shrink-0 flex-col items-center gap-1.5 self-start rounded-2xl border bg-card p-1.5 [&_svg]:size-5">
      {/* The one way to draw, shown rather than chosen. There was a pen beside
          it — a stroke that settled into these same points on release — and it
          only ever cost the line its corners on the way. A turn is a close and
          an open, so a tool that rounds them off is a tool that changes the
          trade. */}
      <Tip words="Drag across the chart to draw. Then drag a point to move it, or double-click to remove it.">
        <span className="flex size-10 items-center justify-center rounded-xl bg-accent text-foreground">
          <WaypointsIcon />
        </span>
      </Tip>

      <Separator className="my-0.5 w-6" orientation="horizontal" />

      <Tip words="Undo the last stroke">
        <Button aria-label="Undo" className="size-10 rounded-xl" disabled={!canUndo} onClick={onUndo} variant="ghost">
          <Undo2Icon />
        </Button>
      </Tip>
      <Tip words="Clear the line">
        <Button aria-label="Clear" className="size-10 rounded-xl" disabled={!canUndo} onClick={onClear} variant="ghost">
          <EraserIcon />
        </Button>
      </Tip>

      <Menu>
        <MenuTrigger render={<Button aria-label="Shapes" className="size-10 rounded-xl" variant="ghost" />}>
          <ShapesIcon />
        </MenuTrigger>
        <MenuPopup align="start" className="w-[40rem] p-2" side="right">
          <div className="grid grid-cols-4 gap-1">
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
