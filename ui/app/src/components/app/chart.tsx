"use client";

import {
  AreaSeries,
  BarSeries,
  type CandlestickData,
  CandlestickSeries,
  createChart,
  CrosshairMode,
  HistogramSeries,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  LineSeries,
  LineStyle,
  PriceScaleMode,
  type SeriesType,
  type UTCTimestamp,
} from "lightweight-charts";
import { ChevronDownIcon } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { cn } from "@/lib/utils";
import {
  bollinger,
  ema,
  macd as macdOf,
  rsi as rsiOf,
  volume as volumeOf,
} from "@/lib/indicators";
import { type Candle, price as fmtPrice, usd } from "@/lib/market";
import {
  paletteServerSnapshot,
  paletteSnapshot,
  subscribePalette,
} from "@/lib/theme";

/**
 * The price chart.
 *
 * This was ~470 lines of hand-drawn SVG. It drew a good candle, and it was the
 * right call while the screen only had to *show* a price: every colour was a
 * CSS variable, so it followed the theme for free, and dragging a level was
 * native.
 *
 * It is lightweight-charts now, because pro mode asks for pan, zoom,
 * scrollback, a log scale, four series types, a volume histogram and panes of
 * indicators — and each of those is a week of getting edge cases wrong.
 * TradingView have already got them right, it is Apache-2.0, and its only
 * dependency is their own canvas shim.
 *
 * Two things the library does not give us, both handled below:
 *
 *   Colour. A canvas takes strings, so the palette is read out of CSS once and
 *   re-read when the theme changes. `theme.ts` is the entire cost of the swap.
 *
 *   Draggable levels. `IPriceLine` is display-only — their API has
 *   `applyOptions` and `options` and nothing else. So the line is theirs and
 *   the grip is ours: an absolutely positioned strip whose `y` comes from
 *   `priceToCoordinate` on a rAF loop, written straight to the DOM so that
 *   panning does not re-render React sixty times a second.
 */

export type ChartKind = "candles" | "bars" | "line" | "area";
export type Overlay = "ma" | "bollinger";
export type Study = "volume" | "rsi" | "macd";

/** What each study pane calls itself on its own label. */
const STUDY_NAME: Record<Study, string> = {
  macd: "MACD",
  rsi: "RSI 14",
  volume: "Volume",
};

export type Level = {
  /** Stable across renders; the grips are keyed on it. */
  id: string;
  price: number;
  label: string;
  /** A key into the palette. */
  tone: "up" | "down" | "warning" | "brand" | "fgMuted";
  draggable?: boolean;
  onChange?: (price: number) => void;
};

/** The moving averages, and the colours they are drawn in. */
const MA = [
  { period: 7, tone: "brand" as const },
  { period: 25, tone: "warning" as const },
  { period: 99, tone: "fgMuted" as const },
];

/** Palette keys are camelCase; the CSS variables they read are not. */
const TONE_VAR: Record<Level["tone"], string> = {
  brand: "brand",
  down: "down",
  fgMuted: "muted-foreground",
  up: "up",
  warning: "warning-foreground",
};

/** The line lightweight-charts draws between panes, in px. */
const SEPARATOR = 1;

const seconds = (ms: number) => Math.floor(ms / 1000) as UTCTimestamp;

export function PriceChart({
  candles,
  kind,
  overlays,
  studies,
  logScale,
  levels,
  fitToken,
  onCloseStudy,
  legend: withLegend = true,
  className,
}: {
  candles: Candle[];
  kind: ChartKind;
  overlays: Overlay[];
  studies: Study[];
  logScale: boolean;
  levels: Level[];
  /** Changes when the toolbar's "fit" is pressed. */
  fitToken: number;
  /** Folds a study pane away from the pane itself, not just the toolbar. */
  onCloseStudy?: (study: Study) => void;
  /** The OHLC readout on hover. Desk only — see the note where it renders. */
  legend?: boolean;
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const gripLayer = useRef<HTMLDivElement>(null);
  const studyLayer = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const priceSeries = useRef<ISeriesApi<SeriesType> | null>(null);
  const [legend, setLegend] = useState<Candle | null>(null);

  // Null through the server render and through hydration, then the real values
  // — which is also what keeps the canvas out of the server render entirely.
  const palette = useSyncExternalStore(
    subscribePalette,
    paletteSnapshot,
    paletteServerSnapshot,
  );

  // `levels` is rebuilt on every keystroke in the ticket. The drag handler
  // reads it through a ref so it does not have to be torn down and rebuilt for
  // a price that moved by a dollar.
  const levelsRef = useRef(levels);
  useEffect(() => {
    levelsRef.current = levels;
  }, [levels]);

  /**
   * The EMA values, keyed by bar time.
   *
   * The library will print a series title on the price axis — that is the
   * coloured "EMA 25" plate every terminal has stacked up the right-hand edge.
   * Ours go in the legend instead, next to the OHLC they belong with, so the
   * axis stays a scale. A lookup table rather than series references because
   * the legend only ever needs one bar's worth.
   */
  const maValues = useMemo(
    () =>
      overlays.includes("ma")
        ? MA.map(({ period, tone }) => ({
            at: new Map(ema(candles, period).map((p) => [p.time, p.value])),
            period,
            tone,
          }))
        : [],
    [candles, overlays],
  );

  const data = useMemo(
    () =>
      candles.map((c) => ({
        close: c.c,
        high: c.h,
        low: c.l,
        open: c.o,
        time: seconds(c.t),
      })) as CandlestickData<UTCTimestamp>[],
    [candles],
  );

  /* ---- the chart, rebuilt only when the palette changes -------------------- */

  useEffect(() => {
    const el = box.current;
    if (!el || !palette) return;

    const instance = createChart(el, {
      autoSize: true,
      crosshair: {
        horzLine: {
          color: palette.fgSubtle,
          labelBackgroundColor: palette.fg,
          style: LineStyle.Dashed,
          width: 1,
        },
        mode: CrosshairMode.Normal,
        vertLine: {
          color: palette.fgSubtle,
          labelBackgroundColor: palette.fg,
          style: LineStyle.Dashed,
          width: 1,
        },
      },
      grid: {
        horzLines: { color: palette.grid },
        vertLines: { color: palette.grid },
      },
      layout: {
        // Their watermark. Apache-2.0 is satisfied by the NOTICE we ship, so
        // the logo is off: it would be a second brand on the one surface this
        // product is actually about.
        attributionLogo: false,
        background: { color: palette.surface },
        fontFamily: "var(--font-sans), ui-sans-serif, system-ui, sans-serif",
        fontSize: 12,
        panes: {
          separatorColor: palette.hairline,
          separatorHoverColor: palette.surface3,
        },
        textColor: palette.fgSubtle,
      },
      rightPriceScale: {
        borderColor: palette.hairline,
        borderVisible: true,
        scaleMargins: { bottom: 0.22, top: 0.08 },
      },
      timeScale: {
        barSpacing: 7,
        borderColor: palette.hairline,
        borderVisible: true,
        minBarSpacing: 2,
        /**
         * Fold a column away and the chart gets 240px wider. Without these the
         * library keeps the bar spacing and extends the visible range past the
         * first candle, so the space a folded panel gave back arrives as an
         * empty strip on the left instead of as more chart.
         *
         * `lockVisibleTimeRangeOnResize` keeps the same bars in view and widens
         * them; the two edges stop a pan or a pinch from finding that
         * emptiness later.
         */
        fixLeftEdge: true,
        lockVisibleTimeRangeOnResize: true,
        rightOffset: 10,
        secondsVisible: false,
        timeVisible: true,
      },
    });

    chart.current = instance;
    return () => {
      instance.remove();
      chart.current = null;
      priceSeries.current = null;
    };
  }, [palette]);

  /* ---- the series --------------------------------------------------------- */

  useEffect(() => {
    const instance = chart.current;
    if (!instance || !palette || data.length === 0) return;

    const added: ISeriesApi<SeriesType>[] = [];
    const keep = (s: ISeriesApi<SeriesType>) => {
      added.push(s);
      return s;
    };

    /**
     * Their default prints 69000.00. Ours is the rule the rest of the screen
     * uses, so the axis, the tags and the ticket all round a price the same
     * way.
     *
     * On the series rather than on the chart: `localization.priceFormatter` is
     * chart-wide, so it also reformats the volume pane's axis and labels a
     * histogram in dollars and cents.
     */
    const priceFormat = {
      formatter: (value: number) => fmtPrice(value),
      minMove: 0.01,
      /**
       * At most ten labels, whatever the height.
       *
       * The library targets a fixed pixel gap between ticks, so a 600px pane —
       * which is what Draw is — comes back with twenty-five of them and the
       * axis reads as a ruler. There is no tick-count option; this hook hands
       * over every value at once, so thinning is a modulo. The gridlines stay
       * where they were: they are nearly invisible against the panel, and it
       * is the column of figures that was shouting.
       */
      tickmarksFormatter: (values: readonly number[]) => {
        const every = Math.max(1, Math.ceil(values.length / 10));
        return values.map((value, i) =>
          i % every === 0 ? fmtPrice(value) : "",
        );
      },
      type: "custom",
    } as const;

    /**
     * Keep the levels you can drag inside the band you can see.
     *
     * Autoscale looks at the series data and nothing else, so a stop dragged
     * below the low leaves the chart, its grip pins to the edge, and the next
     * drag starts from a price that is not where the pointer is. Extending the
     * range here is what makes the grip and the line the same object.
     *
     * Capped at half the candle range on each side, and only for levels you
     * can move. A liquidation at 10× sits about 9% away — roughly as far as a
     * day of candles travels — so letting it in would halve the height of the
     * thing the chart is for. It is drawn where it falls and left off the top
     * or bottom if that is where it falls.
     */
    const autoscaleInfoProvider = (
      base: () => { priceRange: { minValue: number; maxValue: number } } | null,
    ) => {
      const info = base();
      if (!info) return info;
      const prices = levelsRef.current
        .filter((level) => level.draggable)
        .map((level) => level.price);
      if (prices.length === 0) return info;

      const { maxValue, minValue } = info.priceRange;
      const span = maxValue - minValue || Math.abs(maxValue) || 1;
      return {
        ...info,
        priceRange: {
          maxValue: Math.max(
            maxValue,
            Math.min(Math.max(...prices), maxValue + span * 0.5),
          ),
          minValue: Math.min(
            minValue,
            Math.max(Math.min(...prices), minValue - span * 0.5),
          ),
        },
      };
    };

    const shared = { autoscaleInfoProvider };

    let main: ISeriesApi<SeriesType>;
    if (kind === "candles") {
      main = keep(
        instance.addSeries(CandlestickSeries, {
          ...shared,
          priceFormat,
          lastValueVisible: true,
          priceLineVisible: true,
          priceLineStyle: LineStyle.Dotted,
          priceLineWidth: 1,
          borderDownColor: palette.downMark,
          borderUpColor: palette.upMark,
          downColor: palette.downMark,
          upColor: palette.upMark,
          wickDownColor: palette.downMark,
          wickUpColor: palette.upMark,
        }),
      );
      main.setData(data);
    } else if (kind === "bars") {
      main = keep(
        instance.addSeries(BarSeries, {
          ...shared,
          priceFormat,
          downColor: palette.downMark,
          openVisible: true,
          upColor: palette.upMark,
        }),
      );
      main.setData(data);
    } else {
      const closes = data.map((d) => ({ time: d.time, value: d.close }));
      main = keep(
        kind === "line"
          ? instance.addSeries(LineSeries, {
              ...shared,
              color: palette.brand,
              lineWidth: 2,
              priceFormat,
            })
          : instance.addSeries(AreaSeries, {
              ...shared,
              bottomColor: "rgba(0, 0, 0, 0)",
              priceFormat,
              lineColor: palette.brand,
              lineWidth: 2,
              topColor: palette.upSoft,
            }),
      );
      main.setData(closes);
    }
    priceSeries.current = main;

    if (overlays.includes("ma")) {
      for (const { period, tone } of MA) {
        const points = ema(candles, period);
        if (points.length === 0) continue;
        const line = keep(
          instance.addSeries(LineSeries, {
            color: palette[tone],
            crosshairMarkerVisible: false,
            lastValueVisible: false,
            lineWidth: 1,
            priceLineVisible: false,
          }),
        );
        line.setData(
          points.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })),
        );
      }
    }

    if (overlays.includes("bollinger")) {
      const bands = bollinger(candles);
      for (const [band, style] of [
        [bands.upper, LineStyle.Solid],
        [bands.middle, LineStyle.Dashed],
        [bands.lower, LineStyle.Solid],
      ] as const) {
        if (band.length === 0) continue;
        const line = keep(
          instance.addSeries(LineSeries, {
            color: palette.fgSubtle,
            crosshairMarkerVisible: false,
            lastValueVisible: false,
            lineStyle: style,
            lineWidth: 1,
            priceLineVisible: false,
          }),
        );
        line.setData(
          band.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })),
        );
      }
    }

    // Studies, each in its own pane below the price. Panes are indexed from 1
    // in the order they are added, so the running count is the pane number.
    let pane = 0;

    if (studies.includes("volume")) {
      const bars = keep(
        instance.addSeries(HistogramSeries, {
          lastValueVisible: false,
          priceFormat: { type: "volume" },
          priceLineVisible: false,
          priceScaleId: "volume",
        }),
      );
      instance.priceScale("volume").applyOptions({
        scaleMargins: { bottom: 0, top: 0.8 },
        visible: false,
      });
      bars.setData(
        volumeOf(candles).map((v) => ({
          color: v.rising ? palette.upSoft : palette.downSoft,
          time: v.time as UTCTimestamp,
          value: v.value,
        })),
      );
    }

    if (studies.includes("rsi")) {
      pane += 1;
      const line = keep(
        instance.addSeries(
          LineSeries,
          {
            color: palette.brand,
            lastValueVisible: false,
            lineWidth: 1,
            priceLineVisible: false,
          },
          pane,
        ),
      );
      line.setData(
        rsiOf(candles).map((p) => ({
          time: p.time as UTCTimestamp,
          value: p.value,
        })),
      );
      // 70 and 30, the two lines everybody reads RSI against.
      for (const level of [70, 30]) {
        line.createPriceLine({
          color: palette.fgSubtle,
          lineStyle: LineStyle.Dotted,
          lineWidth: 1,
          price: level,
          title: "",
        });
      }
    }

    if (studies.includes("macd")) {
      pane += 1;
      const { histogram, macd: line, signal } = macdOf(candles);
      const bars = keep(
        instance.addSeries(
          HistogramSeries,
          { lastValueVisible: false, priceLineVisible: false },
          pane,
        ),
      );
      bars.setData(
        histogram.map((p) => ({
          color: p.value >= 0 ? palette.upSoft : palette.downSoft,
          time: p.time as UTCTimestamp,
          value: p.value,
        })),
      );
      const macdLine = keep(
        instance.addSeries(
          LineSeries,
          {
            color: palette.brand,
            lastValueVisible: false,
            lineWidth: 1,
            priceLineVisible: false,
          },
          pane,
        ),
      );
      macdLine.setData(
        line.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })),
      );
      const signalLine = keep(
        instance.addSeries(
          LineSeries,
          {
            color: palette.warning,
            lastValueVisible: false,
            lineWidth: 1,
            priceLineVisible: false,
          },
          pane,
        ),
      );
      signalLine.setData(
        signal.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })),
      );
    }

    /**
     * Pane heights, as stretch factors rather than pixels.
     *
     * `setHeight` is in the API and it is the wrong tool: setting an absolute
     * height on three of four panes in the same tick collapses every pane to
     * zero — verified, the canvases come back 1900×0 and the chart renders as
     * an empty box with a time axis under it. Stretch factors are the
     * proportional model the library actually lays panes out with.
     *
     * Four to one: the price keeps most of the room with one study open and
     * still over half of it with three.
     */
    const panes = instance.panes();
    if (panes.length > 1) {
      panes[0].setStretchFactor(3);
      for (let i = 1; i < panes.length; i++) panes[i].setStretchFactor(1);
    }

    // Show the last stretch of bars, not every bar squeezed to width. Applied
    // now and again after layout: on first mount the container has no width
    // yet, and a range set against a zero-width scale comes out as a fit.
    const shown = Math.min(data.length, 130);
    const applyRange = () =>
      instance.timeScale().setVisibleLogicalRange({
        from: data.length - shown,
        to: data.length + 10,
      });
    applyRange();
    const raf = requestAnimationFrame(() => requestAnimationFrame(applyRange));

    return () => {
      cancelAnimationFrame(raf);
      for (const s of added) {
        try {
          instance.removeSeries(s);
        } catch {
          // The chart was disposed first, which takes its series with it.
        }
      }
      priceSeries.current = null;
    };
  }, [candles, data, kind, overlays, studies, palette]);

  /* ---- scale and fit ------------------------------------------------------ */

  useEffect(() => {
    chart.current?.priceScale("right").applyOptions({
      mode: logScale ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal,
    });
  }, [logScale]);

  useEffect(() => {
    chart.current?.timeScale().fitContent();
  }, [fitToken]);

  /* ---- the legend --------------------------------------------------------- */

  useEffect(() => {
    const instance = chart.current;
    if (!instance) return;
    const handler = (param: { time?: unknown }) => {
      if (param.time === undefined) {
        setLegend(null);
        return;
      }
      const t = Number(param.time) * 1000;
      setLegend(candles.find((c) => c.t === t) ?? null);
    };
    instance.subscribeCrosshairMove(handler);
    return () => instance.unsubscribeCrosshairMove(handler);
  }, [candles]);

  /* ---- levels: their line, our grip --------------------------------------- */

  useEffect(() => {
    const series = priceSeries.current;
    if (!series || !palette) return;

    const lines: IPriceLine[] = levels.map((level) =>
      series.createPriceLine({
        axisLabelVisible: true,
        color: palette[level.tone],
        lineStyle: LineStyle.Dashed,
        lineWidth: 1,
        price: level.price,
        title: level.label,
      }),
    );

    return () => {
      for (const line of lines) {
        try {
          series.removePriceLine(line);
        } catch {
          // Series already gone; its price lines went with it.
        }
      }
    };
  }, [levels, palette]);

  /**
   * The grips.
   *
   * One strip per draggable level, positioned from the price scale every frame
   * and written straight to `style.transform`. Going through React here would
   * be a render per frame while panning, for an element whose only state is a
   * number of pixels.
   */
  useEffect(() => {
    const layer = gripLayer.current;
    if (!layer) return;
    let frame = 0;

    const tick = () => {
      frame = requestAnimationFrame(tick);

      /**
       * Study labels, stacked down the panes.
       *
       * A pane knows its own height but not where it starts, so the offsets are
       * accumulated: pane n begins below everything above it, plus a separator
       * each. Same frame loop as the grips, and the same rule — only touch the
       * DOM when the number actually changed.
       */
      const labels = studyLayer.current;
      const panes = chart.current?.panes() ?? [];
      if (labels && panes.length > 1) {
        let top = 0;
        for (const [i, child] of (
          Array.from(labels.children) as HTMLElement[]
        ).entries()) {
          top += (panes[i]?.getHeight() ?? 0) + SEPARATOR;
          const next = `translateY(${Math.round(top) + 4}px)`;
          if (child.style.transform !== next) child.style.transform = next;
        }
      }

      const series = priceSeries.current;
      if (!series) return;
      const height = chart.current?.panes()[0]?.getHeight() ?? 0;
      for (const child of Array.from(layer.children) as HTMLElement[]) {
        const y = series.priceToCoordinate(Number(child.dataset.price));
        if (y === null || height === 0) {
          child.style.visibility = "hidden";
          continue;
        }
        // Clamped so a level sitting just off the edge is still grabbable
        // rather than being a 14px strip somewhere outside the panel.
        const clamped = Math.min(Math.max(y, 7), height - 7);
        const next = `translateY(${Math.round(clamped) - 7}px)`;
        if (child.style.transform !== next) child.style.transform = next;
        child.style.visibility = "visible";
      }
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  const startDrag = (id: string) => (event: React.PointerEvent) => {
    const series = priceSeries.current;
    const rect = box.current?.getBoundingClientRect();
    if (!series || !rect) return;

    event.preventDefault();
    const target = event.currentTarget as HTMLElement;
    try {
      target.setPointerCapture(event.pointerId);
    } catch {
      // Capture is an optimisation; without it the drag ends at the edge.
    }

    const move = (e: PointerEvent) => {
      const height = chart.current?.panes()[0]?.getHeight() ?? rect.height;
      const y = Math.min(Math.max(e.clientY - rect.top, 0), height);
      const next = series.coordinateToPrice(y);
      if (next === null) return;
      levelsRef.current.find((l) => l.id === id)?.onChange?.(Number(next));
    };
    const end = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", end);
      target.removeEventListener("pointercancel", end);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", end);
    target.addEventListener("pointercancel", end);
  };

  return (
    <div className={cn("relative h-full w-full", className)}>
      <div className="h-full w-full" ref={box} />

      {/* The grips sit over the canvas. `pointer-events-none` on the layer and
          `auto` on each strip, so only the 14px band under a level takes the
          pointer and the rest of the chart still pans. */}
      <div
        className="pointer-events-none absolute inset-0 overflow-hidden"
        ref={gripLayer}
      >
        {levels
          .filter((level) => level.draggable)
          .map((level) => (
            // biome-ignore lint/a11y/noStaticElementInteractions: the keyboard
            // path to this value is the field in the ticket, which is a real
            // input; this is the pointer shortcut to the same state.
            <div
              className="pointer-events-auto absolute inset-x-0 top-0 h-3.5 cursor-ns-resize"
              data-price={level.price}
              key={level.id}
              onPointerDown={startDrag(level.id)}
            />
          ))}
      </div>

      {/*
        One label per study pane, with its own fold.
        
        The toolbar can turn a study off, but the toolbar is a row of six words
        at the top of the panel and the pane is 300px below it — so closing the
        thing you are looking at means finding the word that matches it. The
        label also names the pane, which nothing did before: a histogram with a
        0-200 axis and no caption is a mystery until you hover it.
        
        A chevron rather than a cross: folded, the same chip stays at the foot
        of the panel pointing the other way, so this is a drawer and not a
        delete. A cross promises the label is going away with the pane.
        
        It points at the pane, not at the gesture. This chip sits on top of the
        pane it closes, so down is where the thing it acts on is; the chip in
        the tray sits under where the pane will reappear, so it points up. Read
        as a disclosure triangle instead — expanded up, collapsed down — both
        end up pointing away from the pane they are about.
      */}
      <div
        className="pointer-events-none absolute inset-x-0 top-0 z-10"
        ref={studyLayer}
      >
        {studies.filter((study) => study !== "volume").map((study) => (
          <div className="absolute left-2" key={study}>
            <button
              className="pointer-events-auto flex items-center gap-1 rounded-md border bg-popover px-2 py-0.5 text-muted-foreground text-xs shadow-xs/5 hover:text-foreground"
              onClick={() => onCloseStudy?.(study)}
              type="button"
            >
              {STUDY_NAME[study]}
              <ChevronDownIcon className="size-3.5" />
            </button>
          </div>
        ))}
      </div>

      {/* The readout, and only while a pointer is on the chart. xStream prints
          O H L C permanently in the corner, which is four figures nobody asked
          for sitting on top of the one picture the screen is about. */}
      {/*
        Desk only. "O H L C" is four letters that mean nothing until somebody
        tells you, and Draw is the mode for the reader nobody has told. The
        price is already at the top of the panel, which is the part of this a
        person who has never traded was going to read anyway.
      */}
      {withLegend && legend ? (
        <div className="pointer-events-none absolute top-2 left-2 z-10 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 rounded-md border bg-popover px-2.5 py-1 text-xs shadow-xs/5">
          {(
            [
              ["O", legend.o],
              ["H", legend.h],
              ["L", legend.l],
              ["C", legend.c],
            ] as const
          ).map(([label, value]) => (
            <span className="flex items-baseline gap-1" key={label}>
              <span className="text-muted-foreground">{label}</span>
              <span
                className={cn(
                  "figures",
                  legend.c >= legend.o ? "text-up" : "text-down",
                )}
              >
                {fmtPrice(value)}
              </span>
            </span>
          ))}
          <span className="flex items-baseline gap-1">
            <span className="text-muted-foreground">Vol</span>
            <span className="figures">{usd(legend.v, 2)}</span>
          </span>
          {maValues.map(({ at, period, tone }) => {
            const value = at.get(Math.floor(legend.t / 1000));
            if (value === undefined) return null;
            return (
              <span className="flex items-baseline gap-1" key={period}>
                <span className="text-muted-foreground">EMA {period}</span>
                <span
                  className="figures"
                  style={{ color: `var(--${TONE_VAR[tone]})` }}
                >
                  {fmtPrice(value)}
                </span>
              </span>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
