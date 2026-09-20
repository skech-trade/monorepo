"use client";

import { EraserIcon, SettingsIcon, ShapesIcon, SlidersHorizontalIcon, Undo2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Drawer, DrawerClose, DrawerPopup, DrawerTitle, DrawerTrigger } from "@/components/ui/drawer";
import type { Exits } from "@/lib/sketch";
import { Segmented } from "../controls";
import { ChartSettings, PlotSettings } from "../settings";
import { setDark, useDark } from "../theme-toggle";
import { ExitPanel } from "./exit-controls";
import { PRESETS, type Preset, Thumb } from "./draw-tools";

/**
 * Everything that is not the trade, on a phone.
 *
 * The header was three rows: the market, a rail of five tools, and the ticket
 * pushed to the right with a gap beside it. On a screen this size that is a
 * third of the chart spent on things nobody presses twice a round.
 *
 * So the rail goes in here and the header is two rows: the market, then size,
 * boost and the button. A drawer rather than a menu because a menu anchored
 * to a rail at the left edge opened mostly off the screen, and because up
 * from the bottom is where a thumb already is.
 */
export function PhoneTools({
  canUndo,
  onUndo,
  onClear,
  onPreset,
  exits,
  stake,
  onExits,
  drawing,
  className,
}: {
  canUndo: boolean;
  onUndo: () => void;
  onClear: () => void;
  onPreset: (preset: Preset) => void;
  exits: Exits;
  stake: number;
  onExits: (exits: Exits) => void;
  /** While a round runs the line is not yours to change, so those tools go. */
  drawing: boolean;
  className?: string;
}) {
  const set = Number(exits.lose !== null) + Number(exits.gain !== null);
  const dark = useDark();

  return (
    <Drawer>
      <DrawerTrigger asChild>
        {/* Square when it holds only the icon, so it is not a wide pill with
            the icon adrift in it. It grows only when there is a count to show. */}
        <Button aria-label="Tools and settings" className={cn("size-10 shrink-0 rounded-full border bg-card/85 backdrop-blur-sm", set > 0 && "w-auto gap-1 px-2.5", className)} size="icon" variant="outline">
          <SlidersHorizontalIcon />
          {set > 0 ? <span className="figures text-muted-foreground text-xs">{set}</span> : null}
        </Button>
      </DrawerTrigger>
      <DrawerPopup>
        {drawing ? (
          <>
            <DrawerTitle>Your line</DrawerTitle>
            <div className="flex gap-2 pb-4">
              <DrawerClose asChild>
                <Button className="flex-1" disabled={!canUndo} onClick={onUndo} variant="outline">
                  <Undo2Icon />
                  Undo
                </Button>
              </DrawerClose>
              <DrawerClose asChild>
                <Button className="flex-1" disabled={!canUndo} onClick={onClear} variant="outline">
                  <EraserIcon />
                  Clear
                </Button>
              </DrawerClose>
            </div>

            <DrawerTitle>Where to get out</DrawerTitle>
            <div className="pb-4">
              <ExitPanel exits={exits} onExits={onExits} stake={stake} />
            </div>

            <DrawerTitle>
              <ShapesIcon className="mr-1.5 inline size-4 align-[-0.15em]" />
              Or start from a shape
            </DrawerTitle>
            {/* Two across, because eight of these down a phone is a scroll
                and the pictures are the point. */}
            <div className="grid grid-cols-2 gap-1.5 pb-4">
              {PRESETS.map((p) => (
                <DrawerClose asChild key={p.value}>
                  {/* Our own button, hand-rolled before: it had the border and
                      the hover and none of the focus ring, the pressed state
                      or the inner edge every other button on the screen has. */}
                  <Button className="h-auto flex-col items-stretch gap-1.5 rounded-2xl p-2 text-left before:rounded-2xl" onClick={() => onPreset(p.value)} variant="outline">
                    <span className="block aspect-[20/9] w-full">
                      <Thumb shape={p.shape} />
                    </span>
                    <span className="px-0.5 pb-0.5 font-medium text-xs">{p.label}</span>
                  </Button>
                </DrawerClose>
              ))}
            </div>
          </>
        ) : null}

        <DrawerTitle>
          <SettingsIcon className="mr-1.5 inline size-4 align-[-0.15em]" />
          Chart
        </DrawerTitle>
        {/* Light or dark lives here now: the app bar on a phone holds the
            logo, the market and the way in, with no room for a fourth. */}
        <div className="flex items-center justify-between gap-4 py-2">
          <p className="text-sm">Theme</p>
          <Segmented
            label="Light or dark"
            onChange={(next) => setDark(next === "dark")}
            options={[
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
            ]}
            size="sm"
            value={dark ? "dark" : "light"}
          />
        </div>
        <ChartSettings />
        <h3 className="pt-3 pb-1 font-medium text-muted-foreground text-xs">On the drawing</h3>
        <PlotSettings />
      </DrawerPopup>
    </Drawer>
  );
}
