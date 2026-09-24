"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckIcon } from "lucide-react";
import { PopoverClose } from "@/components/ui/popover";
import styles from "./amount-wheel.module.css";

const STEP = 5;
const MIN = 20;
const MAX = 500;
/**
 * A figure on a wheel; the middle row is a field, click to type. The stake runs $20 to $500; the
 * exits from zero, where zero reads Off.
 */
export function AmountWheel({
  value,
  onChange,
  min = MIN,
  max = MAX,
  step = STEP,
  offAtZero = false,
  format = (n: number) => `$${n}`,
  label = "How much you put in",
  inPopover = true,
  values,
}: {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  /** The stops themselves, when an even step will not do (cents at the bottom, dollars at the top). Overrides min, max and step. */
  values?: number[];
  /** Show the bottom stop as "Off" rather than "$0". */
  offAtZero?: boolean;
  /**
   * Whether a popover is closing around this.
   *
   * The tick in the corner is a `PopoverClose`, and Base UI throws if one is
   * rendered with no popover above it. In the phone drawer the wheel sits on
   * the panel itself with nothing to close, so there is nothing to show.
   */
  inPopover?: boolean;
  /** How a figure reads on the wheel. Dollars unless told otherwise. */
  format?: (n: number) => string;
  /** What the wheel is for, for anyone listening rather than looking. */
  label?: string;
}) {
  const AMOUNTS = useMemo(
    () => values ?? Array.from({ length: Math.floor((max - min) / step) + 1 }, (_, i) => min + i * step),
    [values, min, max, step],
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
    // The nearest stop, when the stops are given; else the step.
    const clamped = values
      ? values.reduce((best, v) => (Math.abs(v - typed) < Math.abs(best - typed) ? v : best), values[0])
      : Math.min(max, Math.max(min, Math.round(typed / step) * step));
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
      <div
        aria-label={label}
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
              /* Any visible row picks itself; the middle one opens for typing. */
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
              {offAtZero && amount === 0 ? "Off" : format(amount)}
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
            aria-label={label}
            autoFocus
            className="figures relative w-20 bg-transparent text-center font-semibold text-xl outline-none"
            autoComplete="off"
            inputMode="decimal"
            onBlur={commit}
            onChange={(e) => setDraft(e.target.value.replace(/[^0-9.]/g, ""))}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") setEditing(false);
            }}
            type="text"
            value={draft}
          />
        </div>
      ) : null}
      {/*
        Done sits inside the lit band, raised above the typing overlay, and commits a half-typed
        figure first.
      */}
      {inPopover ? (
      <PopoverClose
        aria-label="Done"
        className="-translate-y-1/2 absolute top-1/2 right-1.5 z-10 flex size-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-background hover:text-foreground [&_svg]:size-4"
        // Mid-typing, it takes what is in the field first. Closing the panel
        // pulls the input out of the document, and a value that was typed and
        // never read back is the one thing a tick must not do.
        onClick={() => {
          if (editing) commit();
        }}
      >
        <CheckIcon />
      </PopoverClose>
      ) : null}
    </div>
  );
}
