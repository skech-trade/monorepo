"use client";

import { practice } from "./practice";

/*
  How the game feels: sound and touch.

  Every sound is synthesized here, nothing is downloaded, so the first tap is
  heard as soon as it lands. Everything runs through one bus with a
  compressor on it: ten hits in one second stay loud without clipping.

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
  if (typeof window === "undefined") return null;
  if (!audio) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    audio = new Ctor({ latencyHint: "interactive" });
    const squash = audio.createDynamicsCompressor();
    squash.threshold.value = -16;
    squash.knee.value = 8;
    squash.ratio.value = 4;
    squash.attack.value = 0.002;
    squash.release.value = 0.12;
    bus = audio.createGain();
    bus.gain.value = 0.9;
    bus.connect(squash).connect(audio.destination);
  }
  if (audio.state === "suspended") void audio.resume();
  return audio;
}

/*
  Browsers start audio suspended and only let a completed gesture start it: a pointerup, a click, a key, never a
  pointerdown from a finger. So the first finished tap anywhere on the page unlocks it, and on iPhones plays one
  silent sample inside that gesture, which is what Safari needs before it will play anything later.
*/
function unlock() {
  const a = ctx();
  if (!a) return;
  const b = a.createBuffer(1, 1, a.sampleRate);
  const src = a.createBufferSource();
  src.buffer = b;
  src.connect(a.destination);
  src.start(0);
  if (a.state === "running") {
    for (const type of ["pointerup", "touchend", "keydown", "click"]) document.removeEventListener(type, unlock, true);
  }
}
if (typeof document !== "undefined") {
  for (const type of ["pointerup", "touchend", "keydown", "click"]) document.addEventListener(type, unlock, true);
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
  o.onended = () => {
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
  src.onended = () => {
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
    v.src.onended = () => {
      v.src.disconnect();
      v.gain.disconnect();
    };
  },
};

export const sound = {
  /** Unlock audio from inside a completed gesture. The page does this by itself; see `unlock`. */
  wake: unlock,

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
  Touch. Android has navigator.vibrate. iPhones do not, but Safari gives a
  system haptic when a switch control is flipped, so a hidden one is flipped
  instead. From iOS 17.4 to 26.4 a switch flipped from script did it. iOS
  26.5 (WebKit bug 309082) ended that: a script's label.click() now reaches
  the switch as an untrusted click, and those do not buzz. Only a finger on a
  real label with a switch in it still does: see HapticHost, which wraps the
  game. A haptic asked for during a tap on it is owed to that tap's own click,
  and plays then, once; every other tap on it is kept from flipping the
  switch. A haptic with no finger behind it (a hit, seconds on) cannot be felt
  on an iPhone any more; it still plays on older iOS, and on Android.
*/
export type Feel = "tap" | "tick" | "hit" | "big" | "win" | "nope" | "cash";

const VIBRATE: Record<Feel, number | number[]> = {
  tap: 10,
  tick: 4,
  hit: 18,
  big: [24, 40, 24, 40, 60],
  win: [14, 50, 28],
  nope: [18, 60, 18],
  cash: [12, 40, 12, 40, 40],
};
/** How many switch flips each is on an iPhone: it has one strength, so a pattern is a count. */
const FLIPS: Record<Feel, number> = { tap: 1, tick: 0, hit: 1, big: 3, win: 2, nope: 2, cash: 3 };

let flipper: HTMLLabelElement | null = null;
const ios = () =>
  typeof navigator !== "undefined" && (/iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));

function flip() {
  if (!flipper) {
    flipper = document.createElement("label");
    flipper.setAttribute("aria-hidden", "true");
    flipper.style.cssText = "position:fixed;left:-100px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;overflow:hidden";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.setAttribute("switch", "");
    input.tabIndex = -1;
    flipper.append(input);
    document.body.append(flipper);
  }
  flipper.click();
}

/** When a finger last came down on a HapticHost, and whether a haptic was asked for since. */
let armedAt = -Infinity;
let owed = false;
/** A tap on a HapticHost began: a haptic asked for now is played by its click. */
export function armHaptic() {
  armedAt = performance.now();
  owed = false;
}
/** That tap's click, on the host's label: the switch flips (and buzzes) only if a haptic is owed. */
export function settleHaptic(e: { preventDefault(): void }) {
  if (owed) owed = false;
  else e.preventDefault();
}

export function haptic(kind: Feel) {
  if (typeof window === "undefined" || !practice().haptics) return;
  try {
    if (typeof navigator.vibrate === "function") {
      navigator.vibrate(VIBRATE[kind]);
      return;
    }
    if (!ios() || !FLIPS[kind]) return;
    // A finger is on the host: its own click plays it, on every iOS from 17.4 on. One buzz: a tap has one click.
    if (performance.now() - armedAt < 1000) {
      owed = true;
      return;
    }
    for (let i = 0; i < FLIPS[kind]; i++) {
      if (i === 0) flip();
      else setTimeout(flip, i * 90);
    }
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
