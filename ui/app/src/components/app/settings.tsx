"use client";

import { SettingsIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetDescription, SheetHeader, SheetPanel, SheetPopup, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { useSettings } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { Segmented } from "./controls";
import { setDark, useDark } from "./theme-toggle";

/**
 * What the reader has set. The chart's own three sit under a gear on the
 * chart, beside what they change; everything is also in the sheet, which is
 * where the avatar menu has always pointed.
 */

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div className="min-w-0">
        <p>{label}</p>
        {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
      </div>
      {children}
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col">
      <h3 className="pb-1 font-medium text-muted-foreground text-xs">{title}</h3>
      {children}
    </section>
  );
}

/** The three the chart itself is drawn by. Shared by the gear and the sheet. */
export function ChartSettings({ className }: { className?: string }) {
  const [settings, set] = useSettings();
  return (
    <div className={cn("flex flex-col", className)}>
      <Row hint="Blue and orange if red and green read the same to you." label="Colours">
        <Segmented
          label="Up and down colours"
          onChange={(palette) => set({ palette })}
          options={[
            { value: "classic", label: "Green" },
            { value: "colourblind", label: "Blue" },
          ]}
          size="sm"
          value={settings.palette}
        />
      </Row>
      <Row label="Candles">
        <Segmented
          label="How the market is drawn"
          onChange={(candles) => set({ candles })}
          options={[
            { value: "candles", label: "Candles" },
            { value: "bars", label: "Bars" },
            { value: "line", label: "Line" },
          ]}
          size="sm"
          value={settings.candles}
        />
      </Row>
      <Row label="Grid">
        <Segmented
          label="Grid behind the future"
          onChange={(grid) => set({ grid })}
          options={[
            { value: "lines", label: "Lines" },
            { value: "dots", label: "Dots" },
            { value: "off", label: "Off" },
          ]}
          size="sm"
          value={settings.grid}
        />
      </Row>
    </div>
  );
}

/** What Draw paints around the line you drew. Not on the Desk, which draws none of it. */
export function PlotSettings({ className }: { className?: string }) {
  const [settings, set] = useSettings();
  return (
    <div className={cn("flex flex-col", className)}>
      <Row hint="The band of profit and loss along your line." label="Ribbon">
        <Switch aria-label="Ribbon" checked={settings.ribbon} onCheckedChange={(ribbon) => set({ ribbon })} />
      </Row>
      <Row hint="Where the line turns, so where it buys and sells." label="Buy and sell marks">
        <Switch aria-label="Buy and sell marks" checked={settings.marks} onCheckedChange={(marks) => set({ marks })} />
      </Row>
      <Row label="Crosshair">
        <Switch aria-label="Crosshair" checked={settings.crosshair} onCheckedChange={(crosshair) => set({ crosshair })} />
      </Row>
    </div>
  );
}

/** The gear in the chart's own controls. */
export function ChartSettingsButton() {
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger
          render={<PopoverTrigger render={<Button aria-label="How the chart looks" className="size-7 rounded-lg" variant="ghost" />} />}
        >
          <SettingsIcon />
        </TooltipTrigger>
        <TooltipPopup>How the chart looks</TooltipPopup>
      </Tooltip>
      <PopoverPopup align="end" className="w-80" side="top">
        <PopoverTitle>Chart</PopoverTitle>
        <ChartSettings className="pt-2" />
        <h3 className="pt-3 pb-1 font-medium text-muted-foreground text-xs">On the drawing</h3>
        <PlotSettings />
      </PopoverPopup>
    </Popover>
  );
}

/** Everything, including the two that are not about the chart. */
export function SettingsSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [settings, set] = useSettings();
  const dark = useDark();
  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetPopup className="sm:max-w-sm" side="right" variant="inset">
        <SheetHeader>
          <SheetTitle>Settings</SheetTitle>
          <SheetDescription>Kept in this browser.</SheetDescription>
        </SheetHeader>
        <SheetPanel className="flex flex-col gap-5">
          <Group title="Appearance">
            <Row label="Theme">
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
            </Row>
          </Group>
          <Group title="Chart">
            <ChartSettings />
          </Group>
          <Group title="On the drawing">
            <PlotSettings />
          </Group>
          <Group title="Privacy">
            <Row hint="Every figure on the screen, for reading it in company." label="Blur the money">
              <Switch aria-label="Blur the money" checked={settings.blurred} onCheckedChange={(blurred) => set({ blurred })} />
            </Row>
          </Group>
        </SheetPanel>
      </SheetPopup>
    </Sheet>
  );
}
