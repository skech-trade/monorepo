import { Canvas, Points, type SkPoint, vec } from "@shopify/react-native-skia";
import { type ReactNode, type Ref, useEffect, useImperativeHandle } from "react";
import { StyleSheet, type StyleProp, TextInput, type TextStyle, View, type ViewStyle } from "react-native";
import Animated, { Easing, interpolate, useAnimatedProps, useAnimatedStyle, useDerivedValue, useReducedMotion, useSharedValue, withDelay, withRepeat, withSequence, withTiming } from "react-native-reanimated";

/*
  The web's motion (drawing-feedback.module.css), on the UI thread: the round card springs in, pills arrive, the
  market row and the dock settle in, a strong round lights the edges. Each plays once as it mounts, so a new key plays
  it again. With the phone's Reduce Motion on, each is simply there, as the web's `prefers-reduced-motion` has it.
*/

/** Where something starts, or passes through, on its way to rest: its opacity, how far down it is (pt), its scale. */
export type Pose = { opacity?: number; y?: number; scale?: number };
/** A CSS cubic-bezier. */
export type Curve = [number, number, number, number];

const REST = { opacity: 1, y: 0, scale: 1 };

/** The web's keyframes, from where each starts to rest: `ms`, `curve`, and on the way a `via`, `at` of the way. */
export const MOTION = {
  /** A profit's card. */
  cardIn: { from: { opacity: 0, y: 14, scale: 0.9 }, ms: 420, curve: [0.2, 1.5, 0.4, 1] },
  /** A strong round's card, harder. */
  cardBig: { from: { opacity: 0, y: 24, scale: 0.7 }, via: { at: 0.6, opacity: 1, y: -4, scale: 1.06 }, ms: 620, curve: [0.2, 1.6, 0.35, 1] },
  /** A loss, quietly. */
  cardSoft: { from: { opacity: 0, y: 6 }, ms: 240, curve: [0, 0, 0.58, 1] },
  /** What the stroke has put in play, over the chart. */
  pillIn: { from: { opacity: 0, y: -8, scale: 0.94 }, ms: 220, curve: [0.2, 1.3, 0.4, 1] },
  /** The hint and the way in, over the chart. */
  hintIn: { from: { opacity: 0, y: -8, scale: 0.94 }, ms: 320, curve: [0.2, 1.3, 0.4, 1] },
  /** Money back, over the dock. */
  pillUp: { from: { opacity: 0, y: 8, scale: 0.94 }, ms: 260, curve: [0.2, 1.3, 0.4, 1] },
  /** The market row, when the game first shows. */
  settle: { from: { opacity: 0, y: -6 }, ms: 420, curve: [0.2, 0.8, 0.2, 1] },
  /** The dock, just after it. */
  dockIn: { from: { opacity: 0, y: 18 }, ms: 460, curve: [0.2, 1.2, 0.4, 1], delay: 80 },
  /** A run of profitable rounds: its badge pops in just after the card. */
  badgePop: { from: { opacity: 0, y: 6, scale: 0.3 }, via: { at: 0.6, opacity: 1, y: 0, scale: 1.12 }, ms: 560, curve: [0.2, 1.8, 0.4, 1], delay: 180 },
} satisfies Record<string, { from: Pose; via?: Pose & { at: number }; ms: number; curve: Curve; delay?: number }>;

/** Plays one of `MOTION` as it mounts: from its start, through its `via`, to rest, each stretch on its curve. */
export function Arrive({ motion, style, pointerEvents, children }: { motion: { from: Pose; via?: Pose & { at: number }; ms: number; curve: Curve; delay?: number }; style?: StyleProp<ViewStyle>; pointerEvents?: "box-none" | "none" | "auto"; children: ReactNode }) {
  const still = useReducedMotion();
  const { from, via, ms, curve, delay = 0 } = motion;
  const k = useSharedValue(still ? 1 : 0);
  useEffect(() => {
    if (still) return;
    const easing = Easing.bezier(...curve);
    k.value = withDelay(delay, via ? withSequence(withTiming(via.at, { duration: ms * via.at, easing }), withTiming(1, { duration: ms * (1 - via.at), easing })) : withTiming(1, { duration: ms, easing }));
  }, [still, k, curve, delay, ms, via]);
  const moved = useAnimatedStyle(() => {
    const at = via ? [0, via.at, 1] : [0, 1];
    const poses: Pose[] = via ? [from, via, REST] : [from, REST];
    const pick = (p: keyof Pose) => interpolate(k.value, at, poses.map((q) => q[p] ?? REST[p]));
    return { opacity: Math.min(1, pick("opacity")), transform: [{ translateY: pick("y") }, { scale: pick("scale") }] };
  });
  return (
    <Animated.View pointerEvents={pointerEvents} style={[style, moved]}>
      {children}
    </Animated.View>
  );
}

/** The hint's slow breath, from 600ms after it arrives: a little larger and back, every 2.6s. */
export function Breathe({ children }: { children: ReactNode }) {
  const still = useReducedMotion();
  const scale = useSharedValue(1);
  useEffect(() => {
    if (still) return;
    const easing = Easing.bezier(0.42, 0, 0.58, 1);
    scale.value = withDelay(600, withRepeat(withSequence(withTiming(1.035, { duration: 1300, easing }), withTiming(1, { duration: 1300, easing })), -1));
  }, [still, scale]);
  const style = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  return <Animated.View style={style}>{children}</Animated.View>;
}

/** The balance as money comes back: a small bounce up while it is green, and back. Transformed from its right edge, where it is pinned. */
export function Bump({ on, children }: { on: boolean; children: ReactNode }) {
  const still = useReducedMotion();
  const scale = useSharedValue(1);
  useEffect(() => {
    scale.value = still ? 1 : withTiming(on ? 1.08 : 1, { duration: 240, easing: Easing.bezier(0.2, 1.6, 0.4, 1) });
  }, [on, still, scale]);
  const style = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  return <Animated.View style={[{ transformOrigin: "right center" }, style]}>{children}</Animated.View>;
}

/**
 * A strong round lights the edges of the screen, once: up to its brightest a quarter of the way through, then gone.
 * A top round's is deeper, longer, and comes twice.
 */
export function Glow({ color, ms = 1300, top = false }: { color: string; ms?: number; top?: boolean }) {
  const still = useReducedMotion();
  const k = useSharedValue(0);
  useEffect(() => {
    if (still) return;
    const easing = Easing.bezier(0, 0, 0.58, 1);
    k.value = top
      ? withSequence(withTiming(1, { duration: 400, easing }), withTiming(0.45, { duration: 500, easing }), withTiming(0.9, { duration: 450, easing }), withTiming(0, { duration: 1000, easing }))
      : withSequence(withTiming(1, { duration: ms * 0.25, easing }), withTiming(0, { duration: ms * 0.75, easing }));
  }, [still, k, ms, top]);
  const style = useAnimatedStyle(() => ({ opacity: k.value }));
  if (still) return null;
  return <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { zIndex: 24, boxShadow: top ? `inset 0 0 150px 24px ${color}` : `inset 0 0 110px 14px ${color}` }, style]} />;
}

/**
 * A profit's light: a soft glow behind what it wraps (the round's figure, the balance) that swells twice and fades,
 * as the web's profit-glow does. Plays as it mounts; a new key plays it again. Not at all with Reduce Motion on.
 */
export function ProfitGlow({ color, delay = 120, children }: { color: string; delay?: number; children: ReactNode }) {
  const still = useReducedMotion();
  const k = useSharedValue(0);
  useEffect(() => {
    if (still) return;
    const easing = Easing.bezier(0, 0, 0.58, 1);
    k.value = withDelay(delay, withSequence(withTiming(1, { duration: 370, easing }), withTiming(0.5, { duration: 390, easing }), withTiming(0.85, { duration: 340, easing }), withTiming(0, { duration: 600, easing })));
  }, [still, k, delay]);
  const style = useAnimatedStyle(() => ({ opacity: k.value, transform: [{ scale: interpolate(k.value, [0, 1], [0.7, 1.08]) }] }));
  return (
    <View>
      {still ? null : <Animated.View pointerEvents="none" style={[{ position: "absolute", top: -4, bottom: -4, left: -14, right: -14, borderRadius: 999, backgroundColor: color, boxShadow: `0 0 22px 10px ${color}` }, style]} />}
      {children}
    </View>
  );
}

/** $1,234.56, on the UI thread: the count-up's figure, a frame at a time, floored so it never passes where it is going. */
function moneyText(n: number) {
  "worklet";
  const [whole, frac] = (Math.floor(Math.abs(n) * 100 + 1e-6) / 100).toFixed(2).split(".");
  let out = "";
  for (let i = 0; i < whole.length; i++) {
    if (i && (whole.length - i) % 3 === 0) out += ",";
    out += whole[i];
  }
  return `$${out}.${frac}`;
}
const AnimatedInput = Animated.createAnimatedComponent(TextInput);
/** How long money takes to count up to a gain, ms: quick enough that it is never the figure being waited on. */
const RISE_MS = 650;

/**
 * Money that counts up to a gain, cent by cent, on the UI thread, rather than jumping to it; anything else (a stake
 * going out, the first figure) is simply shown. A read-only field, as Reanimated sets text without React: the screen
 * never renders for it. With Reduce Motion on, it jumps. Whoever shows it says the true amount to a screen reader.
 */
export function RisingMoney({ value, className, style, size = 16 }: { value: number; className?: string; style?: StyleProp<TextStyle>; size?: number }) {
  const still = useReducedMotion();
  const shown = useSharedValue(value);
  useEffect(() => {
    if (still || !(value > shown.value)) shown.value = value;
    else shown.value = withTiming(value, { duration: RISE_MS, easing: Easing.out(Easing.cubic) });
  }, [value, still, shown]);
  const props = useAnimatedProps(() => ({ text: moneyText(shown.value), defaultValue: moneyText(shown.value) }));
  return (
    <AnimatedInput
      accessible={false}
      animatedProps={props}
      caretHidden
      className={className}
      defaultValue={moneyText(value)}
      editable={false}
      importantForAccessibility="no"
      pointerEvents="none"
      scrollEnabled={false}
      // Wide enough for the figure it is counting to: text set from the UI thread does not lay the field out again.
      style={[{ padding: 0, margin: 0, textAlign: "right", minWidth: moneyText(value).length * size * 0.62 }, style]}
      underlineColorAndroid="transparent"
    />
  );
}

export type ConfettiHandle = { fire: (x: number, y: number, pieces: number, tier: number) => void };
/** The most pieces in the air at once: a top round's. */
const MOST = 120;
const FLIGHT_MS = 2200;
/** Where one colour's pieces are, `ms` into their flight: a little air (speed falls away over 0.9 s), and gravity. */
function flying(p: number[], ms: number, hue: number) {
  "worklet";
  const out: SkPoint[] = [];
  if (ms >= FLIGHT_MS) return out;
  const TAU = 900;
  const flown = TAU * (1 - Math.exp(-ms / TAU));
  const fall = 0.00055 * ms * ms;
  for (let i = 0; i < p.length; i += 5) if (p[i + 4] === hue) out.push(vec(p[i] + p[i + 2] * flown, p[i + 1] + p[i + 3] * flown + fall));
  return out;
}

/**
 * Confetti, thrown from where the price met a profitable round's ink: its own canvas over the chart, every piece
 * moved on the UI thread from where and how fast it was thrown, so the JS thread (the pen, the chart) pays nothing
 * for it. Three of the app's colours, a few shapes; up and out in a fountain, then falling, fading at the end. None
 * with Reduce Motion on.
 */
export function Confetti({ ref, colors }: { ref: Ref<ConfettiHandle>; colors: [string, string, string] }) {
  const still = useReducedMotion();
  // Each piece: where it starts, how fast it goes (px/ms), and which colour. Flat, so it crosses to the UI thread cheaply.
  const pieces = useSharedValue<number[]>([]);
  const t = useSharedValue(FLIGHT_MS);
  useImperativeHandle(ref, () => ({
    fire: (x, y, n, tier) => {
      if (still) return;
      const reach = 0.75 + tier * 0.18;
      const next: number[] = [];
      for (let k = 0; k < Math.min(MOST, n); k++) {
        const a = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 0.95;
        const v = (0.32 + Math.random() * 0.38) * reach;
        next.push(x + (Math.random() - 0.5) * 8, y + (Math.random() - 0.5) * 8, Math.cos(a) * v, Math.sin(a) * v - 0.12 * reach, k % 3);
      }
      pieces.value = next;
      t.value = 0;
      t.value = withTiming(FLIGHT_MS, { duration: FLIGHT_MS, easing: Easing.linear });
    },
  }), [still, pieces, t]);
  const first = useDerivedValue(() => flying(pieces.value, t.value, 0)),
    second = useDerivedValue(() => flying(pieces.value, t.value, 1)),
    third = useDerivedValue(() => flying(pieces.value, t.value, 2));
  const opacity = useDerivedValue(() => Math.max(0, Math.min(1, (FLIGHT_MS - t.value) / 500)));
  if (still) return null;
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Canvas style={StyleSheet.absoluteFill}>
        <Points color={colors[0]} mode="points" opacity={opacity} points={first} strokeCap="square" strokeWidth={6} style="stroke" />
        <Points color={colors[1]} mode="points" opacity={opacity} points={second} strokeCap="round" strokeWidth={6} style="stroke" />
        <Points color={colors[2]} mode="points" opacity={opacity} points={third} strokeCap="square" strokeWidth={4.5} style="stroke" />
      </Canvas>
    </View>
  );
}
