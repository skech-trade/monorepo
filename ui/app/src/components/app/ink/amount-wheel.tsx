"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import styles from "./amount-wheel.module.css";

const STEP = 5;
const MIN = 20;
const MAX = 500;
/**
 * A figure on a wheel. Scrolling picks as it goes; tapping a figure picks it
 * and is done (`onPick`), the way a phone's own picker is.
 */
export function AmountWheel({
  value,
  onChange,
  onPick,
  min = MIN,
  max = MAX,
  step = STEP,
  offAtZero = false,
  format = (n: number) => `$${n}`,
  label = "How much you put in",
  values,
}: {
  value: number;
  onChange: (value: number) => void;
  /** A figure was tapped: it is picked, and whatever holds the wheel can close. */
  onPick?: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  /** The stops themselves, when an even step will not do (cents at the bottom, dollars at the top). Overrides min, max and step. */
  values?: number[];
  /** Show the bottom stop as "Off" rather than "$0". */
  offAtZero?: boolean;
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
  const smooth = () => !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const goTo = (next: number) => {
    const clamped = Math.min(AMOUNTS.length - 1, Math.max(0, next));
    onChange(AMOUNTS[clamped]);
    scrollToIndex(clamped, smooth());
  };

  return (
    <div className={styles.wrap}>
      <span aria-hidden="true" className={styles.band} />
      <div
        aria-label={label}
        aria-valuemax={AMOUNTS.at(-1)}
        aria-valuemin={AMOUNTS[0]}
        aria-valuenow={value}
        aria-valuetext={format(value)}
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
          } else if (e.key === "Enter") {
            e.preventDefault();
            onPick?.(value);
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
              /* A tapped figure is the pick: it rolls to the middle, and the wheel is done. */
              onClick={() => {
                onChange(amount);
                if (i !== index) scrollToIndex(i, smooth());
                onPick?.(amount);
              }}
            >
              {offAtZero && amount === 0 ? "Off" : format(amount)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
