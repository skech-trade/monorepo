"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { CheckIcon } from "lucide-react";
import { Popover, PopoverClose, PopoverDescription, PopoverPopup, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { usd } from "@/lib/market";
import { cn } from "@/lib/utils";
import { DRAW_STEPS, LeverageMeter } from "../leverage-meter";
import styles from "./amount-wheel.module.css";

const STEP = 5;
const MIN = 20;
const MAX = 500;
/**
 * A figure on a wheel. The middle row is also a field: click it to type.
 *
 * The stake picks one between $20 and $500; the two exits pick one from zero,
 * where zero reads "Off", because a stop you have not set is not a stop of
 * nothing. One control for all three, because it is the same gesture and
 * nobody should have to learn a second one.
 */
export function AmountWheel({
  value,
  onChange,
  min = MIN,
  max = MAX,
  step = STEP,
  offAtZero = false,
}: {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  /** Show the bottom stop as "Off" rather than "$0". */
  offAtZero?: boolean;
}) {
  const AMOUNTS = useMemo(
    () => Array.from({ length: Math.floor((max - min) / step) + 1 }, (_, i) => min + i * step),
    [min, max, step],
  );
  const wheel = useRef<HTMLDivElement>(null);
  const frame = useRef(0);
  const programmatic = useRef(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const index = Math.max(0, AMOUNTS.findIndex((a) => a >= value));

  const itemHeight = useCallback(() => wheel.current?.querySelector<HTMLElement>(`.${styles.value}`)?.offsetHeight ?? 0, []);

  const scrollToIndex = useCallback(
    (i: number, smooth = false) => {
      const el = wheel.current;
      const height = itemHeight();
      if (!el || height === 0) return;
      programmatic.current = true;
      el.scrollTo({ behavior: smooth ? "smooth" : "instant", top: i * height });
      window.setTimeout(() => {
        programmatic.current = false;
      }, smooth ? 420 : 80);
    },
    [itemHeight],
  );

  useEffect(() => {
    const id = requestAnimationFrame(() => scrollToIndex(index));
    return () => cancelAnimationFrame(id);
    // Mount only: afterwards the scroller is the source of truth.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollToIndex]);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const onScroll = () => {
    const el = wheel.current;
    if (!el || programmatic.current) return;
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const next = Math.round(el.scrollTop / itemHeight());
      onChange(AMOUNTS[Math.min(AMOUNTS.length - 1, Math.max(0, next))]);
    });
  };
  const commit = () => {
    setEditing(false);
    const typed = Number.parseFloat(draft);
    if (!Number.isFinite(typed)) return;
    const clamped = Math.min(max, Math.max(min, Math.round(typed / step) * step));
    onChange(clamped);
    scrollToIndex(AMOUNTS.indexOf(clamped));
  };
  const goTo = (next: number) => {
    const clamped = Math.min(AMOUNTS.length - 1, Math.max(0, next));
    onChange(AMOUNTS[clamped]);
    scrollToIndex(clamped, !window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  };

  return (
    <div className={styles.wrap}>
      <span aria-hidden="true" className={styles.band} />
      {/*
        Done, beside the figure it is agreeing to.

        The wheel applies as it turns, so there is nothing to submit — but
        there was also nothing to press, and the only way out was to click the
        chart, which is the drawing surface. A tick says "that one" and shuts
        the panel, which is the sentence the gesture was already making.

        Inside the lit band rather than floating beside it: the band is the
        selection, so the thing that agrees to the selection belongs in it. Sat
        outside, it was a second object at the edge of a narrow panel with
        nothing tying it to the figure it applied to.
      */}
      <PopoverClose
        aria-label="Done"
        className="-translate-y-1/2 absolute top-1/2 right-1.5 flex size-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-background hover:text-foreground [&_svg]:size-4"
        // Mid-typing, it takes what is in the field first. Closing the panel
        // pulls the input out of the document, and a value that was typed and
        // never read back is the one thing a tick must not do.
        onClick={() => {
          if (editing) commit();
        }}
      >
        <CheckIcon />
      </PopoverClose>
      <div
        aria-label="How much you put in"
        aria-valuemax={max}
        aria-valuemin={min}
        aria-valuenow={value}
        aria-valuetext={`$${value}`}
        className={styles.wheel}
        onKeyDown={(e) => {
          const by = e.key === "ArrowUp" || e.key === "ArrowRight" ? 1 : e.key === "ArrowDown" || e.key === "ArrowLeft" ? -1 : e.key === "PageUp" ? 5 : e.key === "PageDown" ? -5 : 0;
          if (by !== 0) {
            e.preventDefault();
            goTo(index + by);
          } else if (e.key === "Home") {
            e.preventDefault();
            goTo(0);
          } else if (e.key === "End") {
            e.preventDefault();
            goTo(AMOUNTS.length - 1);
          }
        }}
        onScroll={onScroll}
        ref={wheel}
        role="slider"
        tabIndex={0}
      >
        <div className={styles.track}>
          {AMOUNTS.map((amount, i) => (
            <div
              className={styles.value}
              data-near={Math.abs(i - index) === 1 ? "" : undefined}
              data-selected={i === index ? "" : undefined}
              key={amount}
              /*
                A row you can see is a row you can press.

                Only the middle one did anything before, and that was to start
                typing — so the "Off" at the top of an exit wheel looked like a
                choice and was not one, and the only way to reach any value was
                to drag the wheel onto it. Pressing a row now picks it and
                glides it into the middle; pressing the middle one still opens
                it for typing.
              */
              onClick={() => {
                if (i === index) {
                  setDraft(String(value));
                  setEditing(true);
                  return;
                }
                onChange(amount);
                scrollToIndex(i, !window.matchMedia("(prefers-reduced-motion: reduce)").matches);
              }}
            >
              {offAtZero && amount === 0 ? "Off" : `$${amount}`}
            </div>
          ))}
        </div>
      </div>
      {editing ? (
        <div className="absolute inset-0 flex items-center justify-center bg-popover">
          <span aria-hidden="true" className={styles.band} />
          <span className="figures relative font-semibold text-xl">$</span>
          {/* biome-ignore lint/a11y/noAutofocus: the field exists because it was asked for */}
          <input
            aria-label="How much you put in"
            autoFocus
            className="figures relative w-20 bg-transparent text-center font-semibold text-xl outline-none"
            inputMode="decimal"
            onBlur={commit}
            onChange={(e) => setDraft(e.target.value.replace(/[^0-9.]/g, ""))}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") setEditing(false);
            }}
            value={draft}
          />
        </div>
      ) : null}
    </div>
  );
}

/* The label goes on a phone and the figure stays: "$100" beside a wheel of
   dollars needs no word, and the row it is in has four other things in it. */
export function Setting({ label, value }: { label: string; value: string }) {
  return (
    <>
      <span className="hidden text-muted-foreground sm:inline">{label}</span>
      <span className="figures">{value}</span>
    </>
  );
}

/** Size and leverage, each a button wearing its value, each opening a popover. */
export function DrawControls({
  stake,
  leverage,
  onStake,
  onLeverage,
  className,
}: {
  stake: number;
  leverage: number;
  onStake: (stake: number) => void;
  onLeverage: (leverage: number) => void;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-1.5 sm:gap-2", className)}>
      <Popover>
        <PopoverTrigger render={<Button variant="outline" />}>
          <Setting label="Size" value={`$${usd(stake, 0)}`} />
        </PopoverTrigger>
        <PopoverPopup align="start" className="w-56">
          <PopoverTitle>Pick your size</PopoverTitle>
          <PopoverDescription>How much you put in.</PopoverDescription>
          <div className="pt-4">
            <AmountWheel onChange={onStake} value={stake} />
          </div>
        </PopoverPopup>
      </Popover>
      <Popover>
        <PopoverTrigger render={<Button variant="outline" />}>
          <Setting label="Boost" value={`${leverage}×`} />
        </PopoverTrigger>
        <PopoverPopup align="start" className="w-80">
          {/* Draw does not say leverage anywhere else, and the word is the
              single biggest piece of jargon left on this screen. */}
          <PopoverTitle>Set your boost</PopoverTitle>
          <PopoverDescription>
            Put in ${usd(stake, 0)}, trade like ${usd(stake * leverage, 0)}.
          </PopoverDescription>
          <div className="pt-4">
            <LeverageMeter label="Boost" onChange={onLeverage} stake={stake} steps={DRAW_STEPS} value={leverage} />
          </div>
        </PopoverPopup>
      </Popover>
    </div>
  );
}
