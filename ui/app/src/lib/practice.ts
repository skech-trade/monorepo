"use client";

import { useSyncExternalStore } from "react";
import { DOT_BETS, START_BALANCE } from "@skech/core/dots";
import type { InkBet } from "@skech/core/ink";

/**
 * Practice money, kept in this browser: the balance, what you have set, the
 * drawings still in play and the last ones finished.
 *
 * Dollars you cannot lose, so the numbers read the way real ones will. The
 * same engine runs on the server once there is money in it; until then the
 * only thing at stake is the balance in the corner.
 */

export type Brush = "fine" | "medium" | "wide";
/** The pen's radius on screen, in CSS pixels. A thicker pen covers more area, and costs more. */
export const BRUSH_PX: Record<Brush, number> = { fine: 5, medium: 10, wide: 18 };

export type DrawingResult = { id: string; at: number; cost: number; won: number; hits: number; dots: number; best: number };

export type Practice = {
  balance: number;
  /** Drawings in a row with at least one dot hit. */
  streak: number;
  bestStreak: number;
  /** The biggest multiple ever hit. */
  bestHit: number;
  drawings: number;
  history: DrawingResult[];
  perDot: number;
  brush: Brush;
  sound: boolean;
  /** Whether the first-visit hint has been dismissed. */
  taught: boolean;
  /**
   * Drawings still in play. Their cost is already spent, so a reload must
   * not lose them: they are judged again on the minutes of prices the page
   * fetches when it starts.
   */
  open: InkBet[];
};

const DEFAULTS: Practice = {
  balance: START_BALANCE,
  streak: 0,
  bestStreak: 0,
  bestHit: 0,
  drawings: 0,
  history: [],
  perDot: DOT_BETS[0],
  brush: "medium",
  sound: true,
  taught: false,
  open: [],
};

/* Its own name, so drawings kept in an older shape are never read back as strokes. */
const KEY = "skech:practice:ink";
let current: Practice | null = null;
const listeners = new Set<() => void>();

function read(): Practice {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Practice>) } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

export function practice(): Practice {
  if (current === null) current = typeof window === "undefined" ? DEFAULTS : read();
  return current;
}

export function setPractice(patch: Partial<Practice> | ((s: Practice) => Partial<Practice>)) {
  const s = practice();
  current = { ...s, ...(typeof patch === "function" ? patch(s) : patch) };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // Private mode: it still holds for this page.
  }
  for (const l of listeners) l();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  const other = (e: StorageEvent) => {
    if (e.key !== KEY) return;
    current = read();
    fn();
  };
  window.addEventListener("storage", other);
  return () => {
    listeners.delete(fn);
    window.removeEventListener("storage", other);
  };
}

export function usePractice(): Practice {
  return useSyncExternalStore(subscribe, practice, () => DEFAULTS);
}

/** Money to the cent, so sums of dimes do not drift. */
export const cents = (n: number) => Math.round(n * 100) / 100;

/** A finished drawing goes into the books: the streak, the bests, the recent results. */
export function record(result: DrawingResult) {
  setPractice((s) => {
    const streak = result.hits > 0 ? s.streak + 1 : 0;
    return {
      streak,
      bestStreak: Math.max(s.bestStreak, streak),
      bestHit: Math.max(s.bestHit, result.best),
      drawings: s.drawings + 1,
      history: [result, ...s.history].slice(0, 30),
    };
  });
}

/*
  Sound. Every hit sings, pitched to what it paid, so a 20x sounds like one
  without looking. A miss makes no sound at all: nothing is gained by
  punishing it, and a quiet miss next to a loud hit is the contrast that
  makes the hit.
*/
let audio: AudioContext | null = null;
const ctx = () => {
  if (typeof window === "undefined") return null;
  audio ??= new AudioContext();
  if (audio.state === "suspended") void audio.resume();
  return audio;
};

function tone(freq: number, at: number, dur: number, gain: number, type: OscillatorType = "triangle") {
  const a = ctx();
  if (!a) return;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, a.currentTime + at);
  g.gain.setValueAtTime(0, a.currentTime + at);
  g.gain.linearRampToValueAtTime(gain, a.currentTime + at + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + at + dur);
  o.connect(g).connect(a.destination);
  o.start(a.currentTime + at);
  o.stop(a.currentTime + at + dur + 0.02);
}

export const sound = {
  /** Unlock audio inside a gesture: browsers refuse it otherwise. */
  wake: () => void ctx(),
  place: () => tone(740, 0, 0.06, 0.05, "sine"),
  /** A soft tick as the pen covers ground, so drawing is heard as well as seen. */
  paint: () => tone(1320, 0, 0.025, 0.012, "sine"),
  hit: (multiple: number) => {
    // Up a fifth for every doubling of the multiple.
    const base = 523 * 2 ** (Math.log2(Math.max(1, multiple)) * (7 / 12));
    tone(base, 0, 0.18, 0.09);
    tone(base * 1.5, 0.07, 0.22, 0.07);
    if (multiple >= 10) tone(base * 2, 0.14, 0.4, 0.07);
  },
};

export const buzz = (ms: number) => {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* not on this device */
  }
};
