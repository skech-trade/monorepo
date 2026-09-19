import type { ReactNode } from "react";
import { AmountWheel } from "./amount-wheel";
import { StorySection } from "./story-section";
import styles from "./story.module.css";
import { smoothPath } from "./market-data";

/** The three decisions, visible together in their actual order. */
const STEPS: {
  title: string;
  caption: string;
  visual: ReactNode;
}[] = [
  {
    title: "Pick your size",
    caption: "Choose how much you put in.",
    visual: <AmountWheel />,
  },
  {
    title: "Set your boost",
    caption: "Put in $100, trade like $1,000. It cuts both ways.",
    visual: <Leverage />,
  },
  {
    title: "Draw it",
    caption: "Up or down. You only have to be right about the direction.",
    visual: <DrawnLine />,
  },
];

/** The gesture, at a glance. A still is fine here; the live one is the hero. */
const LINE_PTS = [
  { x: 6, y: 62 },
  { x: 34, y: 50 },
  { x: 62, y: 68 },
  { x: 92, y: 78 },
  { x: 122, y: 58 },
  { x: 152, y: 40 },
  { x: 182, y: 46 },
  { x: 214, y: 18 },
];

function DrawnLine() {
  const pts = LINE_PTS;
  const head = pts[pts.length - 1];
  return (
    <svg
      aria-hidden="true"
      className="w-full"
      fill="none"
      viewBox="0 0 220 96"
    >
      <line
        stroke="var(--fg-subtle)"
        strokeDasharray="3 4"
        strokeOpacity="0.35"
        x1="0"
        x2="220"
        y1="62"
        y2="62"
      />
      <path
        d={smoothPath(pts)}
        stroke="var(--brand)"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2.4"
      />
      <circle cx={head.x} cy={head.y} fill="var(--brand)" r="3.6" />
    </svg>
  );
}

/** What you put in. The same three chips the canvas offers, so the two agree. */

/**
 * How big you trade with it.
 *
 * The meter carries the idea and the caption carries the number, so the card
 * reads as something you set rather than something done to you. The multiple
 * itself stays out of the visual, "$500" is the fact a person can act on,
 * "5×" is the fact they have to convert first.
 */
function Leverage() {
  return (
    <div className="flex w-full flex-col justify-center">
      {/*
        Ten notches of fifteen lit, and underneath, what that does to the money.

        Ten of fifteen is also the fix for what the meter used to imply. Ten
        notches with five lit reads as halfway up a scale that stops at ten, so
        the card was quietly saying the most you can do is double while the
        figure beside it said ten times.
      */}
      <div className="grid h-4 auto-cols-fr grid-flow-col gap-1">
        {Array.from({ length: 15 }, (_, i) => (
          <span
            className={
              i < 10
                ? "rounded-full bg-brand"
                : "rounded-full bg-surface-3 transition-colors duration-slow ease-smooth-out group-hover:bg-brand/25"
            }
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length meter
            key={i}
          />
        ))}
      </div>

      {/*
        The left group runs to the tenth notch's centre — (10 - 0.5) / 15, so
        63.33% — plus half the figure that sits at its end, which is what
        centres that figure on the notch rather than ending it there. Half a
        figure is the one measurement that cannot come from the layout, so it is
        written per size: the label is 49/56/63px at sm/base/lg.

        The arrow then takes whatever is left of the group, which is the reason
        it can be a flexible element at all — placed absolutely it would have to
        know how wide the figure beside it is.

        The ceiling figure needs the rest of the scale to itself. Centring the
        thousand pushes its right half past the notch, and below about 1000px
        there is not enough scale left for both: they overlap by 7px at 768 and
        12px at 390. So it appears from `lg`, and under that the five unlit
        notches carry the headroom on their own.

        The arrow is a stretching rule with a solid head butted onto it, not one
        scaled `<svg>`. Stretching a drawn arrow squashes its head along with
        the shaft, and the first attempt, a hairline plus a separate chevron,
        read as two unrelated marks rather than one arrow.

        The arrow and the stake stand down on narrow cards. There are 122px of
        scale on a 360px phone and the figures alone fill it; the caption below
        says "put in $100, trade like $1,000" in full either way.
      */}
      {/*
        The three figures are baseline-aligned, not bottom-aligned. They are
        three different sizes, so matching their boxes leaves the digits sitting
        at three different heights — `items-baseline` is the one thing that puts
        them on a line, and it needs no per-size nudging to do it.

        The arrow opts out with `self-center`: it has no text of its own to
        take a baseline from, and aligned to one it would hang below the digits
        rather than run through them.

        The multiple sits in the arrow rather than over it. Above the shaft it
        had the dot row immediately above and the rule immediately below and
        looked wedged between them; breaking the line around it reads as the
        multiple being applied along the way, and gives it air on both sides
        without needing any.

        That costs width, so the whole arrow waits for `lg`. Below it the row is
        the stake and the figure, and the figure is still centred on the tenth
        notch: at 768px there are 38px between them, which is not an arrow.
      */}
      <div className="mt-2.5 flex items-baseline">
        <div className="flex w-[calc(63.33%+1.53rem)] min-w-0 items-baseline gap-2 sm:w-[calc(63.33%+1.75rem)] md:w-[calc(63.33%+1.97rem)]">
          <span className="hidden figures shrink-0 text-fg-muted text-xs sm:block">
            $100
          </span>
          <span
            aria-hidden="true"
            className="hidden min-w-0 flex-1 items-center gap-1 self-center text-brand/50 lg:flex"
          >
            <span className="h-[1.5px] min-w-0 flex-1 rounded-full bg-current" />
            <span className="figures shrink-0 font-medium text-brand text-[0.6875rem] leading-none">
              10×
            </span>
            <span className="h-[1.5px] min-w-0 flex-1 rounded-full bg-current" />
            <svg
              className="-ml-1.5 shrink-0"
              fill="currentColor"
              height="8"
              viewBox="0 0 7 8"
              width="7"
            >
              <path d="M0 0.4 6.6 4 0 7.6z" />
            </svg>
          </span>
          <span className="figures ml-auto shrink-0 font-medium text-brand text-sm sm:text-base md:text-lg">
            $1,000
          </span>
        </div>
        <span className="ml-auto hidden figures shrink-0 text-fg-subtle text-xs lg:block">
          $1,500
        </span>
      </div>
    </div>
  );
}

export function HowItWorks() {
  return (
    <StorySection
      id="how-it-works"
      titleId="how-title"
      title="Nothing to learn."
      lead="Size, boost, one line. That's it."
      scene="steps"
      overview
    >
      <div className={styles.stepGrid}>
        {STEPS.map((step) => (
          <article className={styles.step} key={step.title}>
            <h3 className={styles.stepTitle}>
              {step.title}
            </h3>
            <div className={styles.stepVisual}>{step.visual}</div>
            <p className={styles.stepCaption}>{step.caption}</p>
          </article>
        ))}
      </div>
    </StorySection>
  );
}
