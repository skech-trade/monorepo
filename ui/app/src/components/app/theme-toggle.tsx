"use client";

import { MoonIcon, SunIcon } from "lucide-react";
import { useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";

function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributeFilter: ["class"], attributes: true });
  return () => observer.disconnect();
}
const isDark = () => document.documentElement.classList.contains("dark");

export function ThemeToggle() {
  const dark = useSyncExternalStore(subscribe, isDark, () => false);
  const words = dark ? "Switch to light" : "Switch to dark";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={words}
            onClick={() => {
              const next = !dark;
              document.documentElement.classList.toggle("dark", next);
              try {
                localStorage.setItem("theme", next ? "dark" : "light");
              } catch {
                // Private mode. The class still flips for this page.
              }
            }}
            size="icon"
            variant="outline"
          />
        }
      >
        {dark ? <SunIcon /> : <MoonIcon />}
      </TooltipTrigger>
      <TooltipPopup>{words}</TooltipPopup>
    </Tooltip>
  );
}
