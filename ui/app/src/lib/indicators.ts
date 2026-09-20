import type { Candle } from "./market";

export type Point = { time: number; value: number };

/** Seconds, which is what lightweight-charts wants for a UTCTimestamp. */
const seconds = (ms: number) => Math.floor(ms / 1000);


/**
 * Seeded from the simple average of the first `period` bars, which is the
 * convention every charting package uses. Seeding from the first close instead
 * makes the line start in the wrong place and take ~3 periods to recover.
 */
export function ema(candles: Candle[], period: number): Point[] {
  if (period < 1 || candles.length < period) return [];
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += candles[i].c;
  let value = seed / period;

  const out: Point[] = [
    { time: seconds(candles[period - 1].t), value },
  ];
  for (let i = period; i < candles.length; i++) {
    value = candles[i].c * k + value * (1 - k);
    out.push({ time: seconds(candles[i].t), value });
  }
  return out;
}

/**
 * Bollinger bands: a moving average with a channel two standard deviations
 * wide either side of it.
 */
export function bollinger(
  candles: Candle[],
  period = 20,
  deviations = 2,
): { upper: Point[]; middle: Point[]; lower: Point[] } {
  const upper: Point[] = [];
  const middle: Point[] = [];
  const lower: Point[] = [];
  if (candles.length < period) return { upper, middle, lower };

  for (let i = period - 1; i < candles.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += candles[j].c;
    const mean = sum / period;

    let variance = 0;
    for (let j = i - period + 1; j <= i; j++) {
      variance += (candles[j].c - mean) ** 2;
    }
    const sd = Math.sqrt(variance / period);
    const time = seconds(candles[i].t);

    middle.push({ time, value: mean });
    upper.push({ time, value: mean + sd * deviations });
    lower.push({ time, value: mean - sd * deviations });
  }
  return { upper, middle, lower };
}

/** Relative strength index with Wilder's smoothing, the version every terminal uses. */
export function rsi(candles: Candle[], period = 14): Point[] {
  if (candles.length <= period) return [];

  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const change = candles[i].c - candles[i - 1].c;
    if (change >= 0) gain += change;
    else loss -= change;
  }
  gain /= period;
  loss /= period;

  const out: Point[] = [
    {
      time: seconds(candles[period].t),
      value: loss === 0 ? 100 : 100 - 100 / (1 + gain / loss),
    },
  ];

  for (let i = period + 1; i < candles.length; i++) {
    const change = candles[i].c - candles[i - 1].c;
    gain = (gain * (period - 1) + Math.max(change, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-change, 0)) / period;
    out.push({
      time: seconds(candles[i].t),
      value: loss === 0 ? 100 : 100 - 100 / (1 + gain / loss),
    });
  }
  return out;
}

/**
 * MACD: the gap between two EMAs, its own average, and the difference between
 * those two as a histogram.
 */
export function macd(
  candles: Candle[],
  fast = 12,
  slow = 26,
  signal = 9,
): { macd: Point[]; signal: Point[]; histogram: Point[] } {
  const fastLine = ema(candles, fast);
  const slowLine = ema(candles, slow);
  if (slowLine.length === 0) return { macd: [], signal: [], histogram: [] };

  // The fast EMA starts earlier, so line it up on the slow one's first bar.
  const offset = fastLine.length - slowLine.length;
  const line: Point[] = slowLine.map((point, i) => ({
    time: point.time,
    value: fastLine[i + offset].value - point.value,
  }));

  // The signal is an EMA of the MACD line, which is a series of points rather
  // than candles, so it is computed here instead of going through `ema`.
  const k = 2 / (signal + 1);
  const signalLine: Point[] = [];
  if (line.length >= signal) {
    let seed = 0;
    for (let i = 0; i < signal; i++) seed += line[i].value;
    let value = seed / signal;
    signalLine.push({ time: line[signal - 1].time, value });
    for (let i = signal; i < line.length; i++) {
      value = line[i].value * k + value * (1 - k);
      signalLine.push({ time: line[i].time, value });
    }
  }

  const start = line.length - signalLine.length;
  const histogram: Point[] = signalLine.map((point, i) => ({
    time: point.time,
    value: line[i + start].value - point.value,
  }));

  return { macd: line, signal: signalLine, histogram };
}

/** Volume, coloured by whether the bar closed up. */
export function volume(
  candles: Candle[],
): { time: number; value: number; rising: boolean }[] {
  return candles.map((c) => ({
    time: seconds(c.t),
    value: c.v,
    rising: c.c >= c.o,
  }));
}
