/**
 * What a chart can be set to. Here rather than in `chart.tsx` so settings and
 * toolbars can name them without pulling in lightweight-charts.
 */

/** Desk chart series. Draw has its own, shorter, list. */
export type ChartKind = "candles" | "bars" | "line" | "area";

/** Drawn on the price pane. */
export type Overlay = "ma" | "bollinger";

/** Drawn in a pane of its own under the price. */
export type Study = "volume" | "rsi" | "macd";
