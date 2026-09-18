"use client";

import {
  ChevronDownIcon,
  EraserIcon,
  PenLineIcon,
  ShapesIcon,
  Undo2Icon,
  WaypointsIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@/components/ui/menu";
import { Separator } from "@/components/ui/separator";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * Two ways to put a line down, and two ways to take it back.
 *
 * Points is a click per turn and is the default: every point is a handle you
 * can move or remove, before and while it plays out. Pen is a finger, and a
 * pen stroke settles into points on release so it edits the same way. Shapes
 * are three common calls, one press each.
 */

export type Tool = "points" | "pen";

export type Preset = "dip-rip" | "straight-up" | "bleed";

export const PRESETS: { value: Preset; label: string; hint: string }[] = [
  { value: "dip-rip", label: "Dip, then run", hint: "Down a little first, then up past where you started." },
  { value: "straight-up", label: "Straight up", hint: "No dip, so the whole stake is on the table." },
  { value: "bleed", label: "Slow bleed", hint: "Drifts down and keeps going." },
];

function Tip({ words, children }: { words: string; children: React.ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipPopup>{words}</TooltipPopup>
    </Tooltip>
  );
}

export function DrawTools({
  tool,
  onTool,
  canUndo,
  onUndo,
  onClear,
  onPreset,
}: {
  tool: Tool;
  onTool: (tool: Tool) => void;
  canUndo: boolean;
  onUndo: () => void;
  onClear: () => void;
  onPreset: (preset: Preset) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <ToggleGroup
        aria-label="Drawing tool"
        onValueChange={(v) => {
          const next = (v as Tool[])[0];
          if (next) onTool(next);
        }}
        size="sm"
        value={[tool]}
        variant="outline"
      >
        <Tip words="Points: click to place, drag to move, double-click to remove">
          <ToggleGroupItem aria-label="Points" value="points">
            <WaypointsIcon />
          </ToggleGroupItem>
        </Tip>
        <Tip words="Pen: drag to draw, it settles into points">
          <ToggleGroupItem aria-label="Pen" value="pen">
            <PenLineIcon />
          </ToggleGroupItem>
        </Tip>
      </ToggleGroup>

      <Separator className="mx-1 h-5" orientation="vertical" />

      <Tip words="Undo the last stroke">
        <Button aria-label="Undo" disabled={!canUndo} onClick={onUndo} size="icon-sm" variant="ghost">
          <Undo2Icon />
        </Button>
      </Tip>
      <Tip words="Clear the line">
        <Button aria-label="Clear" disabled={!canUndo} onClick={onClear} size="icon-sm" variant="ghost">
          <EraserIcon />
        </Button>
      </Tip>

      <Menu>
        <MenuTrigger render={<Button size="sm" variant="ghost" />}>
          <ShapesIcon />
          Shapes
          <ChevronDownIcon className="text-muted-foreground" />
        </MenuTrigger>
        <MenuPopup align="start" className="min-w-64">
          {PRESETS.map((p) => (
            <MenuItem className="flex-col items-start gap-0.5 py-2" key={p.value} onClick={() => onPreset(p.value)}>
              <span>{p.label}</span>
              <span className="text-muted-foreground text-xs">{p.hint}</span>
            </MenuItem>
          ))}
        </MenuPopup>
      </Menu>
    </div>
  );
}
