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
  - A hit is coins, pitched up by the streak: the third hit in a row sounds higher than the first.
  - A big hit adds a sparkle; a big round adds a fanfare.
  - A round that lost makes no sound and no touch: only winning is heard.
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
  sleeps once nothing has sounded for a while, and the next sound wakes it.
*/
const SLEEP_AFTER_MS = 3000;
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

/** A burst of filtered noise: the wet edge of a drop, the rattle of a coin. */
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

  /** A piece the chain took: a soft, low seal under the drop. */
  placed: () => {
    if (!on()) return;
    tone({ freq: 330, to: 262, dur: 0.09, gain: 0.03, type: "triangle" });
  },

  /** Coins, as many as the hit deserves, pitched up a step for every hit in a row. */
  hit: (multiple: number, streak = 0) => {
    if (!on()) return;
    const lift = 2 ** (Math.min(streak, 7) / 12);
    const coins = multiple >= 10 ? 4 : multiple >= 4 ? 3 : 2;
    for (let i = 0; i < coins; i++) {
      const t = i * 0.06;
      const f = vary(1318.5 * lift * (1 + i * 0.12), 10);
      tone({ freq: f, at: t, dur: 0.2, gain: 0.05 });
      tone({ freq: f * 1.5, at: t, dur: 0.11, gain: 0.02 });
      tone({ freq: f * 2.01, at: t, dur: 0.06, gain: 0.012 });
      hiss(t, 0.025, 0.02, 6000, 2);
    }
    // A big hit: a sparkle running up over the coins.
    if (multiple >= 10) for (let i = 0; i < 5; i++) tone({ freq: note(10 + i, 880) * lift, at: 0.22 + i * 0.045, dur: 0.16, gain: 0.03, type: "triangle" });
  },

  /** A round that came out ahead: a rising chord, fuller the more it made. */
  win: (ratio: number) => {
    if (!on()) return;
    const steps = ratio >= 3 ? [0, 2, 4, 5, 7] : [0, 2, 4];
    steps.forEach((s, i) => tone({ freq: note(5 + s, 440), at: 0.05 + i * 0.075, dur: 0.35, gain: 0.045, type: "triangle" }));
    if (ratio >= 3) steps.forEach((s, i) => tone({ freq: note(10 + s, 440), at: 0.4 + i * 0.05, dur: 0.25, gain: 0.02 }));
  },

  /** Refused: ink that could not go in, not enough money. Short, low, twice. */
  nope: () => {
    if (!on()) return;
    tone({ freq: 220, dur: 0.07, gain: 0.05, type: "triangle" });
    tone({ freq: 196, at: 0.09, dur: 0.09, gain: 0.05, type: "triangle" });
  },

  /** Money arrived: a till, then a bright chord. */
  cash: () => {
    if (!on()) return;
    sound.hit(4);
    [0, 2, 4, 7].forEach((s, i) => tone({ freq: note(5 + s, 440), at: 0.2 + i * 0.07, dur: 0.4, gain: 0.04, type: "triangle" }));
  },
};

/*
  Touch: the phone's own haptic engine, which a web page could only borrow. Every one plays, whenever it is asked
  for, finger or not: a hit seconds after the stroke is felt too.
*/
export type Feel = "tap" | "tick" | "hit" | "big" | "win" | "nope" | "cash";

const later = (ms: number, f: () => void) => setTimeout(f, ms);
const HAPTIC: Record<Feel, () => void> = {
  tap: () => void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light),
  tick: () => void Haptics.selectionAsync(),
  hit: () => void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium),
  big: () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    later(90, () => void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy));
    later(180, () => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success));
  },
  win: () => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
  nope: () => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning),
  cash: () => {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    later(140, () => void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium));
  },
};

export function haptic(kind: Feel) {
  if (!practice().haptics) return;
  try {
    HAPTIC[kind]();
  } catch {
    /* not on this device */
  }
}

/** Sound and touch together, which is how nearly everything is felt. */
export function feel(kind: Feel, detail?: { multiple?: number; streak?: number; ratio?: number }) {
  haptic(kind);
  if (kind === "tap") sound.drop();
  // "tick" is touch only: the pen's own sound comes from pen.move.
  else if (kind === "hit" || kind === "big") sound.hit(detail?.multiple ?? 2, detail?.streak ?? 0);
  else if (kind === "win") sound.win(detail?.ratio ?? 1);
  else if (kind === "nope") sound.nope();
  else if (kind === "cash") sound.cash();
}
