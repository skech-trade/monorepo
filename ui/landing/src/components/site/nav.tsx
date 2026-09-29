"use client";

import { SendIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { APP_URL } from "./app-link";
import { FOUNDER, founderChat } from "./founders";
import { LogoLink } from "./logo";

/** An ink splat, drawn once: the way in sits on one, as the pen leaves them. */
const SPLAT = "M36.7 20.0C37.3 20.8 37.3 21.9 37.0 22.7C36.7 23.5 35.7 24.2 35.2 24.9C34.6 25.6 34.1 26.3 33.5 26.9C32.9 27.5 32.2 28.0 31.5 28.4C30.8 28.7 29.7 28.7 29.2 29.2C28.7 29.7 28.6 30.5 28.3 31.5C28.1 32.5 28.2 34.3 27.7 35.2C27.3 36.1 26.3 36.7 25.4 36.7C24.5 36.8 23.3 35.8 22.4 35.3C21.5 34.9 20.8 34.5 20.0 34.2C19.2 34.0 18.5 34.1 17.8 33.9C17.1 33.7 16.5 33.1 15.8 33.0C15.0 32.9 14.3 32.9 13.4 33.0C12.4 33.2 10.9 34.0 9.9 33.9C8.9 33.8 7.9 33.3 7.5 32.5C7.1 31.7 7.6 30.0 7.7 28.9C7.8 27.8 8.2 26.9 8.1 26.1C7.9 25.3 7.2 24.9 6.8 24.3C6.4 23.6 6.0 23.0 5.7 22.3C5.3 21.6 5.2 20.8 4.8 20.0C4.3 19.2 3.4 18.2 3.2 17.3C2.9 16.4 2.8 15.3 3.4 14.6C4.0 13.9 5.7 13.6 6.7 13.2C7.8 12.9 9.1 13.0 9.6 12.5C10.2 12.0 10.1 11.1 10.3 10.3C10.5 9.5 10.6 8.3 11.0 7.6C11.4 6.8 12.1 6.4 12.8 5.8C13.4 5.2 14.1 4.5 14.8 4.1C15.6 3.7 16.5 3.1 17.4 3.3C18.2 3.5 19.2 4.6 20.0 5.4C20.8 6.1 21.3 7.4 22.0 7.6C22.7 7.9 23.4 7.3 24.2 6.9C25.1 6.6 26.4 5.7 27.3 5.6C28.2 5.6 29.1 6.1 29.8 6.5C30.5 7.0 31.0 7.8 31.6 8.4C32.1 9.1 32.8 9.7 33.0 10.5C33.3 11.4 33.0 12.5 32.8 13.5C32.7 14.4 31.8 15.4 32.0 16.1C32.1 16.8 32.9 17.2 33.7 17.8C34.5 18.5 36.2 19.2 36.7 20.0Z";

/**
 * The topbar, fixed at the top and see-through: the page shows under it,
 * blurred, so it floats over the illustrations instead of cutting them off.
 * Three things, as a poster lays them out: the way in on the left (a splat
 * of ink with the pen's mark, and Start drawing), the wordmark in the
 * middle, and a person on the right: a founder, on Telegram. On a desk,
 * hovering the face opens a card first; on a phone a tap goes straight to
 * the chat. A hairline marks the bar's edge once the page is under it.
 */
export function SiteNav() {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const look = () => setScrolled(window.scrollY > 8);
    look();
    window.addEventListener("scroll", look, { passive: true });
    return () => window.removeEventListener("scroll", look);
  }, []);
  return (
    <header
      className={cn(
        "sticky top-0 z-50 border-b border-transparent bg-background/55 backdrop-blur-xl backdrop-saturate-150 transition-[border-color,background-color] duration-fast",
        scrolled && "border-border/70 bg-background/70",
      )}
    >
      <div className="container-x flex items-center gap-3 px-4 py-2.5 sm:grid sm:grid-cols-[1fr_auto_1fr] sm:px-6 md:py-3.5 lg:px-8">
        <a className="group ml-auto flex items-center gap-2 justify-self-start font-semibold text-[0.9375rem] tracking-[-0.01em] sm:ml-0" href={APP_URL}>
          <span className="relative grid size-10 shrink-0 place-items-center">
            <svg aria-hidden="true" className="absolute inset-0 size-full text-brand transition-transform duration-500 ease-smooth-out motion-safe:group-hover:rotate-[160deg]" viewBox="0 0 40 40">
              <path d={SPLAT} fill="currentColor" />
            </svg>
            <svg aria-hidden="true" className="relative size-[18px] text-white" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.2" viewBox="0 0 20 20">
              <path d="M2.4 13.9c2.1 0 3.1-4.1 4.9-4.1 1.4 0 1.9 2.8 3.3 2.8 1.8 0 2.6-5.4 5.2-6.2" />
            </svg>
          </span>
          <span className="whitespace-nowrap transition-colors group-hover:text-brand">Start drawing</span>
        </a>

        {/* In the middle from a tablet up; on a phone first, where three across would crowd it. */}
        <LogoLink className="order-first justify-self-center motion-safe:hover:animate-[logo-wiggle_420ms_ease-in-out_infinite] sm:order-none" />

        <div className="group relative justify-self-end">
          <a
            aria-label={`Talk to ${FOUNDER.name}, a founder, on Telegram`}
            className="pressable relative block rounded-full outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
            href={founderChat}
            rel="noopener noreferrer"
            target="_blank"
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- a 19 KB local photo; the optimiser adds nothing here */}
            <img alt="" className="size-10 rounded-full object-cover ring-2 ring-background" height={40} src={FOUNDER.photo} width={40} />
            <span aria-hidden="true" className="absolute -right-1 -bottom-1 grid size-[18px] place-items-center rounded-full bg-[#2AABEE] text-white ring-2 ring-background">
              <SendIcon className="-ml-px size-2.5" strokeWidth={2.6} />
            </span>
          </a>
          {/* On a desk: who is behind the face, before the chat opens. Grows from the face, as a sticker peels off. */}
          <div className="pointer-events-none absolute top-full right-0 w-72 origin-top-right scale-90 pt-3 opacity-0 transition-[opacity,transform] duration-300 ease-smooth-out group-focus-within:pointer-events-auto group-focus-within:scale-100 group-focus-within:opacity-100 [@media(hover:hover)]:group-hover:pointer-events-auto [@media(hover:hover)]:group-hover:scale-100 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:none)]:hidden">
            <div className="rounded-3xl border border-border bg-background p-4 shadow-lg">
              <div className="flex items-center gap-3">
                {/* eslint-disable-next-line @next/next/no-img-element -- as above */}
                <img alt={FOUNDER.name} className="size-12 rounded-full object-cover" height={48} src={FOUNDER.photo} width={48} />
                <div className="min-w-0">
                  <p className="font-semibold text-[0.9375rem] leading-tight">Talk to the founders</p>
                  <p className="mt-0.5 text-fg-muted text-sm leading-snug">{FOUNDER.name} sets you up in a few minutes.</p>
                </div>
              </div>
              <a className="pressable mt-3.5 flex h-10 items-center justify-center gap-2 rounded-full bg-[#2AABEE] font-medium text-[0.9375rem] text-white hover:brightness-105" href={founderChat} rel="noopener noreferrer" target="_blank">
                <SendIcon className="size-4" strokeWidth={2.2} />
                Message on Telegram
              </a>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}
