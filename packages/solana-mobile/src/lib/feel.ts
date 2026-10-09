import * as Haptics from "expo-haptics";
import { AudioContext, type AudioBuffer, type AudioBufferSourceNode, type BiquadFilterNode, type GainNode, type OscillatorType } from "react-native-audio-api";
import { practice } from "./practice";

/*
  How the game feels: sound and touch, as on the web (ui/app/src/lib/feel.ts), on the phone's own audio and haptics.

  Every sound is synthesized here, nothing is downloaded, so the first tap is
  heard as soon as it lands. Everything runs through one bus.

  The rules the sounds follow:
  - A tap is heard the instant the finger lands, as a drop of ink.
  - Drawing sounds like a pen on paper: a soft scratch that follows the hand's speed and stops with it.
  - A hit is a chime, clean and short, as a payments app confirms money in: a run of correct calls lifts it a
    little each time, and a bigger multiple rings two or three notes up instead of one.
  - A round that came out ahead is a chord, fuller the more it made. No coins, no fanfare: money, not a machine.
  - A miss is a soft knock, heard and not felt.
  - One at a time: see feel(), at the bottom.
  - Anything refused is a short low double note, never a buzzer.
*/

let audio: AudioContext | null = null;
let bus: GainNode | null = null;
let noise: AudioBuffer | null = null;

function ctx(): AudioContext | null {
  if (!audio) {
    try {
      audio = new AudioContext();
    } catch {
      return null;
    }
    // No compressor natively: the bus sits lower instead, so ten hits in a second stay clear of clipping.
    bus = audio.createGain();
    bus.gain.value = 0.6;
    bus.connect(audio.destination);
  }
  if (audio.state === "suspended") void audio.resume();
  sleepSoon();
  return audio;
}

/*
  A running context renders silence on its own thread, all the time: about a third of a core on a cheap phone. It
  sleeps once nothing has sounded for 20s, and the next sound wakes it.
*/
// Long enough that a player drawing stroke after stroke never pays to wake it; short enough to sleep when they stop.
const SLEEP_AFTER_MS = 20_000;
let sleeper: ReturnType<typeof setTimeout> | null = null;
function sleepSoon() {
  if (sleeper) clearTimeout(sleeper);
  sleeper = setTimeout(() => {
    sleeper = null;
    if (penVoice) return sleepSoon();
    if (audio?.state === "running") void audio.suspend();
  }, SLEEP_AFTER_MS);
}

/** Half a second of white noise, made once: every hiss and the pen's scratch are cut from it. */
function noiseBuffer(a: AudioContext): AudioBuffer {
  if (!noise) {
    noise = a.createBuffer(1, Math.floor(a.sampleRate * 0.5), a.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  return noise;
}

const on = () => practice().sound;
/** A few cents either way, so the same sound twice never sounds like a machine. */
const vary = (f: number, cents = 18) => f * 2 ** (((Math.random() * 2 - 1) * cents) / 1200);

type Tone = { freq: number; to?: number; at?: number; dur: number; gain: number; type?: OscillatorType; attack?: number };

function tone({ freq, to, at = 0, dur, gain, type = "sine", attack = 0.004 }: Tone) {
  const a = ctx();
  if (!a || !bus) return;
  const t = a.currentTime + at;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur * 0.8);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(bus);
  o.start(t);
  o.stop(t + dur + 0.03);
  o.onEnded = () => {
    o.disconnect();
    g.disconnect();
  };
}

/** A burst of filtered noise: the wet edge of a drop, the click of a piece going in. */
function hiss(at: number, dur: number, gain: number, freq: number, q = 1.2) {
  const a = ctx();
  if (!a || !bus) return;
  const t = a.currentTime + at;
  const src = a.createBufferSource();
  src.buffer = noiseBuffer(a);
  const band = a.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.value = freq;
  band.Q.value = q;
  const g = a.createGain();
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(band).connect(g).connect(bus);
  src.start(t, Math.random() * 0.4);
  src.stop(t + dur + 0.02);
  src.onEnded = () => {
    src.disconnect();
    band.disconnect();
    g.disconnect();
  };
}

// A major pentatonic from A5: whatever order the notes come in, they never clash.
const PENTA = [0, 2, 4, 7, 9];
const note = (step: number, base = 880) => base * 2 ** ((12 * Math.floor(step / 5) + PENTA[((step % 5) + 5) % 5]) / 12);
// A major triad and its octave, as steps of that scale.
const MAJOR = [0, 2, 3, 5];

/** One clean chime: a sine with a quiet octave over it for the glassy edge, struck fast and let ring. */
function chime(freq: number, at: number, gain: number, dur = 0.32) {
  tone({ freq, at, dur, gain, attack: 0.003 });
  tone({ freq: freq * 2, at, dur: dur * 0.45, gain: gain * 0.22, attack: 0.002 });
}

/** A chord, its notes a few milliseconds apart so it blooms rather than clicks; softer and longer than a chime. */
function chord(steps: number[], base: number, at: number, gain: number, dur: number) {
  steps.forEach((s, i) => {
    tone({ freq: note(s, base), at: at + i * 0.012, dur, gain, attack: 0.012 });
    tone({ freq: note(s, base) * 2, at: at + i * 0.012, dur: dur * 0.5, gain: gain * 0.18, type: "triangle", attack: 0.008 });
  });
}

/*
  The pen: looped noise shaped into the scratch of a nib on paper. A bandpass high in the treble is the nib,
  a quieter low band the paper under it. The voice runs while the pen is down; its loudness follows how fast
  the hand moves, and its colour wanders a little, as a real stroke's does. Still pen, silent pen.
*/
type PenVoice = { src: AudioBufferSourceNode; nib: BiquadFilterNode; gain: GainNode; stopAt: number };
let penVoice: PenVoice | null = null;

export const pen = {
  down: () => {
    const a = ctx();
    if (!a || !bus || !on()) return;
    pen.up();
    const src = a.createBufferSource();
    src.buffer = noiseBuffer(a);
    src.loop = true;
    const nib = a.createBiquadFilter();
    nib.type = "bandpass";
    nib.frequency.value = 3400;
    nib.Q.value = 0.9;
    const paper = a.createBiquadFilter();
    paper.type = "bandpass";
    paper.frequency.value = 950;
    paper.Q.value = 0.7;
    const paperGain = a.createGain();
    paperGain.gain.value = 0.35;
    const gain = a.createGain();
    gain.gain.value = 0;
    src.connect(nib).connect(gain);
    src.connect(paper).connect(paperGain).connect(gain);
    gain.connect(bus);
    src.start(a.currentTime, Math.random() * 0.4);
    penVoice = { src, nib, gain, stopAt: 0 };
  },
  /** How fast the pen is moving, in pixels a millisecond: louder and a touch brighter the faster it goes. */
  move: (speed: number) => {
    const a = audio;
    if (!a || !penVoice) return;
    const t = a.currentTime;
    const level = Math.min(0.09, 0.012 + speed * 0.05);
    // Each move replaces the last one's fade-out, so a steady stroke is a steady scratch.
    penVoice.gain.gain.cancelScheduledValues(t);
    penVoice.gain.gain.setTargetAtTime(level, t, 0.02);
    // Nothing moving for a moment and the scratch dies away by itself.
    penVoice.gain.gain.setTargetAtTime(0, t + 0.06, 0.05);
    penVoice.nib.frequency.setTargetAtTime(vary(2900 + Math.min(speed, 2) * 900, 60), t, 0.03);
  },
  up: () => {
    const a = audio;
    const v = penVoice;
    if (!a || !v) return;
    penVoice = null;
    v.gain.gain.cancelScheduledValues(a.currentTime);
    v.gain.gain.setTargetAtTime(0, a.currentTime, 0.025);
    v.src.stop(a.currentTime + 0.15);
    v.src.onEnded = () => {
      v.src.disconnect();
      v.gain.disconnect();
    };
  },
};

export const sound = {
  /** A drop of ink landing: a falling "plip" with a wet edge. Every tap, the instant it lands. */
  drop: () => {
    if (!on()) return;
    tone({ freq: vary(1250, 40), to: vary(240), dur: 0.11, gain: 0.11, attack: 0.002 });
    tone({ freq: vary(2600, 40), to: 900, dur: 0.035, gain: 0.025, attack: 0.001 });
    hiss(0, 0.03, 0.05, 3200, 1.4);
  },

  /** A piece the chain took: a crisp click, an order going in, with a low knock under it. */
  placed: () => {
    if (!on()) return;
    hiss(0, 0.018, 0.09, 4200, 3);
    hiss(0.012, 0.02, 0.05, 2600, 2.5);
    tone({ freq: vary(520, 30), to: 300, dur: 0.06, gain: 0.05, type: "triangle", attack: 0.001 });
    tone({ freq: 140, to: 90, dur: 0.08, gain: 0.05, attack: 0.002 });
  },

  /**
   * A correct call: one chime, a step up the scale for each call in a run (up to a sixth, so it lifts without
   * squealing). Four times or more rings a second note higher up the scale; ten or more a third, and a soft
   * octave under them for body.
   */
  hit: (multiple: number, run = 0) => {
    if (!on()) return;
    const root = Math.min(run, 4);
    chime(vary(note(root), 6), 0, 0.06);
    if (multiple >= 4) chime(note(root + 2), 0.07, 0.045);
    if (multiple >= 10) {
      chime(note(root + 3), 0.14, 0.04, 0.45);
      tone({ freq: note(root, 440), at: 0.07, dur: 0.5, gain: 0.025, type: "triangle", attack: 0.01 });
    }
  },

  /** Ink the price missed: a short, soft knock on the desk. Quiet: the money is shown, not rubbed in. */
  miss: () => {
    if (!on()) return;
    tone({ freq: 150, to: 95, dur: 0.07, gain: 0.035, attack: 0.002 });
    hiss(0, 0.02, 0.012, 900, 1);
  },

  /**
   * A round that came out ahead: a major chord with a chime on top. Three times its cost or more, the octave and a
   * brighter top note; five times or more, a warm chord a fourth below resolving into it, longer, never louder.
   */
  win: (ratio: number) => {
    if (!on()) return;
    const at = ratio >= 5 ? 0.16 : 0;
    if (ratio >= 5) chord([0, 2, 3], 440 * 2 ** (-7 / 12), 0, 0.03, 0.5);
    chord(ratio >= 3 ? MAJOR : [0, 2, 3], 440, at, 0.035, ratio >= 5 ? 1.2 : 0.8);
    chime(note(ratio >= 3 ? 3 : 0), at + 0.05, 0.04, 0.5);
  },

  /** Refused: ink that could not go in, not enough money. Short, low, twice. */
  nope: () => {
    if (!on()) return;
    tone({ freq: 220, dur: 0.07, gain: 0.05, type: "triangle" });
    tone({ freq: 196, at: 0.09, dur: 0.09, gain: 0.05, type: "triangle" });
  },

  /** Money arrived: two chimes up a major third, as a payments app says it landed, over a soft chord. */
  cash: () => {
    if (!on()) return;
    chime(note(0), 0, 0.055);
    chime(note(2), 0.09, 0.05, 0.45);
    chord(MAJOR, 440, 0.16, 0.025, 0.7);
  },
};

/*
  Touch: the phone's own haptic engine. Few and short, as good apps use it: one or two pulses a moment, never a
  rattle, and only for what is worth feeling. A piece landing and a miss are heard, not felt.
*/
export type Feel = "tap" | "tick" | "placed" | "hit" | "run" | "big" | "win" | "great" | "miss" | "nope" | "cash";

// A pattern's later pulses, so the next pattern can cancel them instead of buzzing over them.
let pulses: ReturnType<typeof setTimeout>[] = [];
const later = (ms: number, f: () => void) => void pulses.push(setTimeout(f, ms));
const impact = (style: Haptics.ImpactFeedbackStyle) => void Haptics.impactAsync(style);
const HAPTIC: Record<Feel, (() => void) | null> = {
  tap: () => impact(Haptics.ImpactFeedbackStyle.Light),
  tick: () => void Haptics.selectionAsync(),
  placed: null,
  hit: () => impact(Haptics.ImpactFeedbackStyle.Medium),
  run: () => {
    impact(Haptics.ImpactFeedbackStyle.Medium);
    later(90, () => impact(Haptics.ImpactFeedbackStyle.Light));
  },
  big: () => {
    impact(Haptics.ImpactFeedbackStyle.Heavy);
    later(120, () => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success));
  },
  win: () => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
  great: () => {
    impact(Haptics.ImpactFeedbackStyle.Medium);
    later(160, () => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success));
  },
  miss: null,
  nope: () => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning),
  cash: () => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
};
// How long each pattern keeps the motor, ms: nothing else is felt until it is done.
const MOTOR: Record<Feel, number> = { tap: 40, tick: 70, placed: 0, hit: 90, run: 160, big: 220, win: 200, great: 360, miss: 0, nope: 200, cash: 200 };
let motorUntil = 0;

/** Plays a pattern now, cutting off whatever pattern was still running. */
function buzz(kind: Feel, now: number) {
  const pattern = HAPTIC[kind];
  if (!pattern || !practice().haptics) return;
  for (const p of pulses) clearTimeout(p);
  pulses = [];
  motorUntil = now + MOTOR[kind];
  try {
    pattern();
  } catch {
    /* not on this device */
  }
}

/** Touch alone, for the sheets' buttons: felt at once, unless the motor is in the middle of something bigger. */
export function haptic(kind: Feel) {
  const now = Date.now();
  if ((kind === "tap" || kind === "tick") && now < motorUntil) return;
  buzz(kind, now);
}

function sounds(kind: Feel, detail?: Detail) {
  if (kind === "tap") sound.drop();
  // "tick" is touch only: the pen's own sound comes from pen.move.
  else if (kind === "placed") sound.placed();
  else if (kind === "hit" || kind === "run" || kind === "big") sound.hit(detail?.multiple ?? 2, detail?.run ?? 0);
  else if (kind === "win" || kind === "great") sound.win(detail?.ratio ?? 1);
  else if (kind === "miss") sound.miss();
  else if (kind === "nope") sound.nope();
  else if (kind === "cash") sound.cash();
}

/*
  One thing at a time. Hits, misses and pieces landing come in bursts (the price runs through a stroke and several
  land in the same second), and played together they smear into noise and a motor that never stops. So every
  moment goes through one queue and plays after the last has had its say, the most important first. A burst of
  one kind becomes one, the biggest of it. Whatever waited too long to still mean something is dropped, and a win
  doesn't wait behind a hit. The finger is the exception: a tap is heard and felt the instant it lands.
*/
/** `run`: correct calls in a row before this one. */
type Detail = { multiple?: number; run?: number; ratio?: number };
const RANK: Record<Feel, number> = { tap: 0, tick: 0, miss: 1, placed: 2, nope: 3, hit: 4, run: 5, big: 6, cash: 7, win: 7, great: 8 };
// How long each has the stage before the next may play, ms.
const HOLD: Record<Feel, number> = { tap: 0, tick: 0, miss: 120, placed: 140, nope: 220, hit: 240, run: 260, big: 420, cash: 600, win: 700, great: 1100 };
// How long each may wait its turn and still mean something, ms.
const FRESH: Record<Feel, number> = { tap: 0, tick: 0, miss: 250, placed: 400, nope: 400, hit: 700, run: 700, big: 1000, cash: 2000, win: 2000, great: 2500 };
const family = (k: Feel) => (k === "hit" || k === "run" || k === "big" ? "hit" : k === "great" ? "win" : k);

let queue: { kind: Feel; detail?: Detail; at: number }[] = [];
let stageUntil = 0;
let stageRank = -1;
let pump: ReturnType<typeof setTimeout> | null = null;

function next() {
  if (pump) clearTimeout(pump);
  pump = null;
  const now = Date.now();
  queue = queue.filter((q) => now - q.at <= FRESH[q.kind]);
  if (!queue.length) return;
  queue.sort((a, b) => RANK[b.kind] - RANK[a.kind] || a.at - b.at);
  const top = queue[0];
  // Still playing, and this isn't far bigger than what is: its turn comes when the stage is free.
  if (now < stageUntil && RANK[top.kind] < stageRank + 3) {
    pump = setTimeout(next, stageUntil - now);
    return;
  }
  queue.shift();
  stageUntil = now + HOLD[top.kind];
  stageRank = RANK[top.kind];
  buzz(top.kind, now);
  if (on()) sounds(top.kind, top.detail);
  if (queue.length) pump = setTimeout(next, HOLD[top.kind]);
}

/** Sound and touch together, which is how nearly everything is felt, in turn. */
export function feel(kind: Feel, detail?: Detail) {
  const now = Date.now();
  if (kind === "tap") {
    if (now >= motorUntil) buzz(kind, now);
    if (on()) sound.drop();
    return;
  }
  // The pen's tick: felt only when nothing else is, so drawing never drowns out a hit.
  if (kind === "tick") {
    if (now >= motorUntil && now >= stageUntil) buzz(kind, now);
    return;
  }
  const same = queue.find((q) => family(q.kind) === family(kind));
  if (same) {
    if (RANK[kind] > RANK[same.kind]) same.kind = kind;
    const d = same.detail ?? {};
    same.detail = { multiple: Math.max(d.multiple ?? 0, detail?.multiple ?? 0) || undefined, run: Math.max(d.run ?? 0, detail?.run ?? 0), ratio: Math.max(d.ratio ?? 0, detail?.ratio ?? 0) || undefined };
  } else queue.push({ kind, detail, at: now });
  next();
}
