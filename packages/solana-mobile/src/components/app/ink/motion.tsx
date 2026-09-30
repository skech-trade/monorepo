import { type ReactNode, useEffect } from "react";
import { StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import Animated, { Easing, interpolate, useAnimatedStyle, useReducedMotion, useSharedValue, withDelay, withRepeat, withSequence, withTiming } from "react-native-reanimated";

/*
  The web's motion (drawing-feedback.module.css), on the UI thread: the round card springs in, pills arrive, the
  market row and the dock settle in, a big win lights the edges. Each plays once as it mounts, so a new key plays
  it again. With the phone's Reduce Motion on, each is simply there, as the web's `prefers-reduced-motion` has it.
*/

/** Where something starts, or passes through, on its way to rest: its opacity, how far down it is (pt), its scale. */
export type Pose = { opacity?: number; y?: number; scale?: number };
/** A CSS cubic-bezier. */
export type Curve = [number, number, number, number];

const REST = { opacity: 1, y: 0, scale: 1 };

/** The web's keyframes, from where each starts to rest: `ms`, `curve`, and on the way a `via`, `at` of the way. */
export const MOTION = {
  /** A win's card. */
  cardIn: { from: { opacity: 0, y: 14, scale: 0.9 }, ms: 420, curve: [0.2, 1.5, 0.4, 1] },
  /** A big win's card, harder. */
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

/** A win's balance: a small bounce up while it is green, and back. Transformed from its right edge, where it is pinned. */
export function Bump({ on, children }: { on: boolean; children: ReactNode }) {
  const still = useReducedMotion();
  const scale = useSharedValue(1);
  useEffect(() => {
    scale.value = still ? 1 : withTiming(on ? 1.08 : 1, { duration: 240, easing: Easing.bezier(0.2, 1.6, 0.4, 1) });
  }, [on, still, scale]);
  const style = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  return <Animated.View style={[{ transformOrigin: "right center" }, style]}>{children}</Animated.View>;
}

/** A big win lights the edges of the screen, once: up to its brightest a quarter of the way through, then gone. */
export function Glow({ color, ms = 1300 }: { color: string; ms?: number }) {
  const still = useReducedMotion();
  const k = useSharedValue(0);
  useEffect(() => {
    if (still) return;
    const easing = Easing.bezier(0, 0, 0.58, 1);
    k.value = withSequence(withTiming(1, { duration: ms * 0.25, easing }), withTiming(0, { duration: ms * 0.75, easing }));
  }, [still, k, ms]);
  const style = useAnimatedStyle(() => ({ opacity: k.value }));
  if (still) return null;
  return <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { zIndex: 24, boxShadow: `inset 0 0 90px 12px ${color}` }, style]} />;
}
