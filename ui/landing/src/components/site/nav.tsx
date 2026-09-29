"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { DrawATrade } from "./app-link";
import { FOUNDER, founderChat } from "./founders";
import { LogoLink } from "./logo";
// Dark mode temporarily disabled.
// import { ThemeToggle } from "./theme-toggle";

/**
 * The topbar, kept at the top as the page scrolls. At the top of the page it
 * offers a person (a founder, on Telegram) and leaves the way in to the
 * hero's own button; once that button has scrolled away, the way in joins
 * the bar, so it is never out of reach.
 *
 * Solid, not glass: over a white page a translucent bar had nothing to tint
 * and read as an empty box. A hairline under it once content passes beneath.
 */
export function SiteNav() {
  // The hero's button, off the top of the screen: the bar carries it instead.
  const [past, setPast] = useState(false);
  useEffect(() => {
    const cta = document.getElementById("hero-cta");
    if (!cta) return;
    const io = new IntersectionObserver(([e]) => setPast(!e.isIntersecting && e.boundingClientRect.top < 0));
    io.observe(cta);
    return () => io.disconnect();
  }, []);
  return (
    <header className={cn("sticky top-0 z-50 bg-background transition-[box-shadow] duration-fast", past && "shadow-[0_1px_0_var(--color-border)]")}>
      <div className="container-x flex items-center justify-between gap-3 px-4 py-3 sm:px-6 md:py-4 lg:px-8">
        <LogoLink />

        <div className="flex items-center gap-2">
          {/* <ThemeToggle /> */}
          <a
            aria-label={`Talk to ${FOUNDER.name}, a founder, on Telegram`}
            className="pressable flex h-9 shrink-0 items-center gap-2 rounded-full bg-surface-2 pr-3.5 pl-1 font-medium text-[0.9375rem] transition-colors duration-micro ease-smooth-out hover:bg-surface-3"
            href={founderChat}
            rel="noopener noreferrer"
            target="_blank"
          >
            <span className="relative shrink-0">
              {/* eslint-disable-next-line @next/next/no-img-element -- a 19 KB local photo; the optimiser adds nothing here */}
              <img alt="" className="size-7 rounded-full object-cover" height={28} src={FOUNDER.photo} width={28} />
              <span aria-hidden="true" className="absolute right-0 bottom-0 size-2 rounded-full bg-up ring-2 ring-surface-2" />
            </span>
            {/* On a phone, with the way in beside it, the face says it. */}
            <span className={cn(past && "max-sm:hidden")}>Talk to founders</span>
          </a>
          {past ? <DrawATrade className="h-9 shrink-0 px-4 text-[0.9375rem] motion-safe:animate-[nav-cta-in_260ms_cubic-bezier(.2,.8,.2,1)_both]" /> : null}
        </div>
      </div>
    </header>
  );
}
