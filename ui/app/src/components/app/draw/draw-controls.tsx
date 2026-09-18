"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverDescription, PopoverPopup, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { usd } from "@/lib/market";
import { cn } from "@/lib/utils";
import { DRAW_STEPS, LeverageMeter } from "../leverage-meter";
import type { Order } from "../ticket";
import styles from "./amount-wheel.module.css";

const STEP = 5;
const MIN = 20;
const MAX = 500;
const AMOUNTS = Array.from({ length: (MAX - MIN) / STEP + 1 }, (_, i) => MIN + i * STEP);

/** The stake, on a wheel. The middle row is also a field: click it to type. */
function AmountWheel({ value, onChange }: { value: number; onChange: (value: number) => void }) {
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
    const clamped = Math.min(MAX, Math.max(MIN, Math.round(typed / STEP) * STEP));
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
        aria-label="How much you put in"
        aria-valuemax={MAX}
        aria-valuemin={MIN}
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
              onClick={i === index ? () => { setDraft(String(value)); setEditing(true); } : undefined}
            >
              ${amount}
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

function Setting({ label, value }: { label: string; value: string }) {
  return (
    <>
      <span className="text-muted-foreground">{label}</span>
      <span className="figures">{value}</span>
    </>
  );
}

/** Size and leverage, each a button wearing its value, each opening a popover. */
export function DrawControls({ order, patch, className }: { order: Order; patch: (next: Partial<Order>) => void; className?: string }) {
  const stake = Number.parseFloat(order.pay) || 100;
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <Popover>
        <PopoverTrigger render={<Button variant="outline" />}>
          <Setting label="Size" value={`$${usd(stake, 0)}`} />
        </PopoverTrigger>
        <PopoverPopup align="start" className="w-56">
          <PopoverTitle>Pick your size</PopoverTitle>
          <PopoverDescription>How much you put in.</PopoverDescription>
          <div className="pt-4">
            <AmountWheel onChange={(v) => patch({ pay: String(v) })} value={stake} />
          </div>
        </PopoverPopup>
      </Popover>
      <Popover>
        <PopoverTrigger render={<Button variant="outline" />}>
          <Setting label="Leverage" value={`${order.leverage}×`} />
        </PopoverTrigger>
        <PopoverPopup align="start" className="w-80">
          <PopoverTitle>Set leverage</PopoverTitle>
          <PopoverDescription>
            Put in ${usd(stake, 0)}, trade like ${usd(stake * order.leverage, 0)}.
          </PopoverDescription>
          <div className="pt-4">
            <LeverageMeter onChange={(leverage) => patch({ leverage })} stake={stake} steps={DRAW_STEPS} value={order.leverage} />
          </div>
        </PopoverPopup>
      </Popover>
    </div>
  );
}
