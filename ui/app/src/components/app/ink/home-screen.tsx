"use client";

import { EllipsisVerticalIcon, ShareIcon, SquarePlusIcon, XIcon } from "lucide-react";
import Image from "next/image";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { Drawer, DrawerClose, DrawerPopup, DrawerTitle } from "@/components/ui/drawer";
import { track } from "@/lib/analytics";
import { cn } from "@/lib/utils";
import feedback from "./drawing-feedback.module.css";

/**
 * Add skech to the Home Screen: a bar in the gap between the chart's time
 * axis and the dock, on a phone's browser only. Install opens the steps
 * (or, on Android when the browser offers it, its own install prompt). The
 * cross puts the gap back, and the bar stays away for a week.
 */

type Platform = "ios" | "android";
/** Chrome's install prompt: not in the DOM's types. */
type InstallPrompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };

const KEY = "skech:home-screen";
const AWAY_MS = 7 * 24 * 3600_000;
/**
 * How much of the chart the bar takes while it shows, in px: the bar and its gaps, 56 + 10 under it + 12 over
 * it, less what `drawingLayout` already leaves between the time axis and the dock (16px on a phone, none wider).
 */
export const homeBarRoom = (width: number) => (width < 640 ? 62 : 80);

/** A phone's browser, not the app already on the Home Screen. Null on a desk, or once installed. */
function platform(): Platform | null {
  const nav = navigator as Navigator & { standalone?: boolean };
  if (nav.standalone || matchMedia("(display-mode: standalone)").matches) return null;
  const ua = nav.userAgent;
  // iPadOS asks for the desktop site and says Macintosh; its touch screen gives it away.
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && nav.maxTouchPoints > 1)) return "ios";
  if (/Android/.test(ua)) return "android";
  return null;
}

function dismissedRecently(): boolean {
  try {
    return Date.now() - Number(localStorage.getItem(KEY) ?? 0) < AWAY_MS;
  } catch {
    return false;
  }
}

/** The phone to offer it on, read once in the browser; never on the server, where there is no phone. */
const offerOn = () => {
  const p = platform();
  return p && !dismissedRecently() ? p : null;
};
const unchanging = () => () => {};

/** Whether to offer it, and what to do on Install and on the cross. */
export function useHomeScreen() {
  const detected = useSyncExternalStore(unchanging, offerOn, () => null);
  const [gone, setGone] = useState(false);
  const where = gone ? null : detected;
  const [prompt, setPrompt] = useState<InstallPrompt | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const offered = (e: Event) => {
      e.preventDefault();
      setPrompt(e as InstallPrompt);
    };
    const installed = () => {
      track("home_screen_installed", { via: "browser" });
      setGone(true);
    };
    addEventListener("beforeinstallprompt", offered);
    addEventListener("appinstalled", installed);
    return () => {
      removeEventListener("beforeinstallprompt", offered);
      removeEventListener("appinstalled", installed);
    };
  }, []);

  const install = useCallback(async () => {
    track("home_screen_install_tapped", { native: prompt !== null });
    if (!prompt) return setOpen(true);
    await prompt.prompt();
    if ((await prompt.userChoice).outcome === "accepted") {
      track("home_screen_installed", { via: "prompt" });
      setGone(true);
    }
    setPrompt(null);
  }, [prompt]);

  const dismiss = useCallback(() => {
    track("home_screen_dismissed");
    setGone(true);
    try {
      localStorage.setItem(KEY, String(Date.now()));
    } catch {}
  }, []);

  return { where, showing: where !== null, install, dismiss, open, setOpen };
}

/** The bar, just over the dock: the pen in its tile says hi, then Install and a cross. */
export function HomeScreenBar({ install, dismiss }: Pick<ReturnType<typeof useHomeScreen>, "install" | "dismiss">) {
  // Once each time it is on screen: the denominator for installs.
  useEffect(() => {
    track("home_screen_shown");
  }, []);
  return (
    <div className={feedback.homeBar} role="region" aria-label="Add skech to your Home Screen">
      <div aria-hidden="true" className={feedback.homeTile}>
        <div className={feedback.homePen}>
          <Image alt="" height={459} src="/assets/pen-mascot.png" width={360} />
        </div>
      </div>
      <div className={feedback.homeText}>
        <strong>Add to Home Screen</strong>
        <span><b>hii!</b> Opens like an app</span>
      </div>
      <Button className="h-9 shrink-0 rounded-full px-4 font-semibold text-sm sm:h-9" onClick={() => void install()} size="sm">
        Install
      </Button>
      <button aria-label="Not now" className="grid size-8 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground" onClick={dismiss} type="button">
        <XIcon className="size-4" strokeWidth={2.4} />
      </button>
    </div>
  );
}

/** How to add it, step by step, for this phone. Closing it keeps the bar. */
export function HomeScreenSheet({ where, open, setOpen }: Pick<ReturnType<typeof useHomeScreen>, "where" | "open" | "setOpen">) {
  const steps =
    where === "android"
      ? [
          <>Tap the menu <Chip><EllipsisVerticalIcon /></Chip></>,
          <>Select <Chip>Add to Home screen <SquarePlusIcon /></Chip></>,
        ]
      : [
          <>Tap the share button <Chip><ShareIcon /></Chip></>,
          <>Select <Chip>Add to Home Screen <SquarePlusIcon /></Chip></>,
        ];
  return (
    <Drawer onOpenChange={setOpen} open={open}>
      <DrawerPopup className="mx-auto max-w-[480px] rounded-t-[28px] bg-background">
        <DrawerTitle className="pt-3 pb-0 text-center font-bold text-[22px]">Get the app</DrawerTitle>
        <Image alt="" className="mx-auto mt-2 h-auto w-full max-w-[400px]" height={475} priority src="/assets/home-screen.png" width={1200} />
        <h2 className="mt-1 text-center font-bold text-[26px] leading-[1.1] tracking-tight">
          Add <span className="text-brand">skech</span>
          <br />
          to Home Screen
        </h2>
        <ol className="mt-5 flex flex-col gap-4 rounded-[20px] bg-muted p-5 text-[16px]">
          {[...steps, <>skech opens like a regular app</>].map((step, i) => (
            <li className="flex min-h-9 items-center gap-3" key={i}>
              <span className="grid size-6 shrink-0 place-items-center rounded-full bg-brand font-bold text-[13px] text-white">{i + 1}</span>
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">{step}</span>
            </li>
          ))}
        </ol>
        <DrawerClose asChild>
          <Button className="mt-5 mb-1 h-12 w-full rounded-full font-semibold text-base sm:h-12">Close</Button>
        </DrawerClose>
      </DrawerPopup>
    </Drawer>
  );
}

function Chip({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cn("inline-flex h-9 items-center gap-2 rounded-[10px] bg-raised px-3 font-medium shadow-[0_1px_2px_rgb(0_0_0/8%)] dark:bg-accent [&_svg]:size-[18px]", className)}>{children}</span>;
}
