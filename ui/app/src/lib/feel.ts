"use client";

import { climbRate, feltLevel, type Tier, type Voice, voiceFor, voiceJob } from "@skech/core/cheer";
import { practice } from "./practice";

/*
  How the game feels: sound and touch.

  Every sound is synthesized here, nothing is downloaded, so the first tap is
  heard as soon as it lands. Everything runs through one bus with a
  compressor on it: ten hits in one second stay loud without clipping.

  The rules the sounds follow:
  - A tap is heard the instant the finger lands, as a drop of ink.
  - Drawing sounds like a pen on paper: a soft scratch that follows the hand's speed and stops with it.
  - Only profit is celebrated. A hit is heard only while its round is ahead: a bell, a step higher for each hit in a
    row, a big one with notes over it. A hit in a round that is still behind is shown, not heard.
  - A round that came out ahead rings up its chord, fuller the more it made, a step up the scale for each profitable
    round in a row (back to the root after one that was not), and the till rings as the money lands in the balance.
  - A round that lost makes no sound and no touch.
  - One at a time: see feel(), at the bottom.
  - Anything refused is a short low double note, never a buzzer.

  The celebrations (packages/core/src/cheer.ts) are made once, a slice at a time while the page is idle, and kept:
  each then plays as one buffer, never a dozen oscillators wired up in the middle of a frame.
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
    prepareVoices();
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
  The celebrations, made once. Not at load: the first finished tap starts audio, and from then on they are made in
  the page's idle time, a few milliseconds a slice, the commonest first, never while the pen is down. One asked for
  before it is ready falls back to the oscillators below, so nothing is ever late waiting for it.
*/
const VOICE_RATE = 32_000;
const VOICE_ORDER: Voice[] = ["win1", "coins", "hit", "win2", "win3", "win4"];
const voices = new Map<Voice, AudioBuffer>();
let making: { voice: Voice; run: (n: number) => boolean; result: () => Float32Array<ArrayBuffer> } | null = null;
let preparing = false;

function prepareVoices() {
  if (preparing) return;
  preparing = true;
  later();
}
function later() {
  if (typeof requestIdleCallback === "function") requestIdleCallback(makeSome, { timeout: 1500 });
  else setTimeout(() => makeSome(), 60);
}
function makeSome(idle?: IdleDeadline) {
  const a = audio;
  if (!a) return;
  // The pen gets the frame to itself: try again once it is up.
  if (penVoice) return void setTimeout(later, 250);
  const until = performance.now() + Math.min(6, idle ? idle.timeRemaining() : 4);
  while (performance.now() < until) {
    if (!making) {
      const next = VOICE_ORDER.find((v) => !voices.has(v));
      if (!next) return;
      making = { voice: next, ...voiceJob(next, VOICE_RATE) };
    }
    if (making.run(1024)) {
      const data = making.result();
      const buffer = a.createBuffer(1, data.length, VOICE_RATE);
      buffer.copyToChannel(data, 0);
      voices.set(making.voice, buffer);
      making = null;
    }
  }
  later();
}

/** Plays a made celebration, `at` seconds from now, `rate` times as fast (and so as high). False if not made yet. */
function voice(v: Voice, { at = 0, rate = 1, gain = 1 }: { at?: number; rate?: number; gain?: number } = {}): boolean {
  const a = ctx();
  const buffer = voices.get(v);
  if (!a || !bus || !buffer) return false;
  const src = a.createBufferSource();
  src.buffer = buffer;
  src.playbackRate.value = rate;
  const g = a.createGain();
  g.gain.value = gain;
  src.connect(g).connect(bus);
  src.start(a.currentTime + at);
  src.onended = () => {
    src.disconnect();
    g.disconnect();
  };
  return true;
}
/** When the till rings after a round's chord, by tier: as the balance's count-up lands, later for the longer chords. */
const TILL_AT: Record<Tier, number> = { 0: 0, 1: 0.26, 2: 0.32, 3: 0.42, 4: 0.62 };


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

  /**
   * A hit while its round is ahead: a bell, a step up for every hit in a row; four times its stake or more rings a
   * fifth over it, ten or more the octave too. Until the bell is made, coins.
   */
  hit: (multiple: number, streak = 0) => {
    if (!on()) return;
    const lift = 2 ** (Math.min(streak, 7) / 12);
    if (voice("hit", { rate: vary(lift, 6) })) {
      if (multiple >= 4) voice("hit", { at: 0.07, rate: lift * 2 ** (7 / 12), gain: 0.7 });
      if (multiple >= 10) voice("hit", { at: 0.14, rate: lift * 2, gain: 0.55 });
      return;
    }
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

  /**
   * A round that came out ahead: its tier's chord (cheer.ts), a step up the scale for each profitable round in a
   * row, and the till as the money lands. Until the chord is made, a rising triangle chord.
   */
  win: (tier: Tier, rounds = 1, till = true) => {
    if (!on() || tier === 0) return;
    const lift = climbRate(rounds);
    if (!voice(voiceFor(tier), { rate: lift })) {
      const steps = tier >= 3 ? [0, 2, 4, 5, 7] : [0, 2, 4];
      steps.forEach((s, i) => tone({ freq: note(5 + s, 440) * lift, at: 0.05 + i * 0.075, dur: 0.35, gain: 0.045, type: "triangle" }));
      if (tier >= 3) steps.forEach((s, i) => tone({ freq: note(10 + s, 440) * lift, at: 0.4 + i * 0.05, dur: 0.25, gain: 0.02 }));
    }
    if (till) voice("coins", { at: TILL_AT[tier], gain: 0.75 + tier * 0.08 });
  },

  /** Refused: ink that could not go in, not enough money. Short, low, twice. */
  nope: () => {
    if (!on()) return;
    tone({ freq: 220, dur: 0.07, gain: 0.05, type: "triangle" });
    tone({ freq: 196, at: 0.09, dur: 0.09, gain: 0.05, type: "triangle" });
  },

  /** Money arrived: the till, then a bright chord. */
  cash: () => {
    if (!on()) return;
    if (voice("coins") && voice("win2", { at: 0.18, gain: 0.85 })) return;
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
/**
 * What can be felt. `hit`, `run` and `big` are a hit while its round is ahead (one, one of a run, one at 10× or more);
 * `win`, `great` and `top` a round that came out ahead (cheer.ts's tiers 1-2, 3 and 4).
 */
export type Feel = "tap" | "tick" | "hit" | "run" | "big" | "win" | "great" | "top" | "nope" | "cash";

const VIBRATE: Record<Feel, number | number[]> = {
  tap: 10,
  tick: 4,
  hit: 18,
  run: [16, 45, 12],
  big: [24, 40, 24, 40, 60],
  win: [18, 70, 26],
  great: [18, 45, 24, 45, 40],
  top: [26, 40, 22, 40, 30, 40, 40, 110, 80],
  nope: [18, 60, 18],
  cash: [12, 40, 12, 40, 40],
};
/**
 * A profitable round, by how strongly it is felt (cheer.ts's `feltLevel`: its tier, more for a run of them): a quick
 * double tap, a firmer one, a rolling triple, and a longer roll with a last beat for a top round.
 */
const WIN_VIBRATE: Record<1 | 2 | 3 | 4, number[]> = {
  1: [18, 70, 26],
  2: [22, 55, 36],
  3: [18, 45, 24, 45, 40],
  4: [26, 40, 22, 40, 30, 40, 40, 110, 80],
};
/** How many switch flips each is on an iPhone: it has one strength, so a pattern is a count. */
const FLIPS: Record<Feel, number> = { tap: 1, tick: 0, hit: 1, run: 2, big: 3, win: 2, great: 3, top: 5, nope: 2, cash: 3 };
const WIN_FLIPS: Record<1 | 2 | 3 | 4, number> = { 1: 2, 2: 2, 3: 3, 4: 5 };
/** A pattern's later flips, so the next pattern cancels them instead of buzzing over them. */
let flips: ReturnType<typeof setTimeout>[] = [];

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

/** Touch: `level` is how strongly a profitable round is felt (1-4); a new pattern replaces whatever was still playing. */
export function haptic(kind: Feel, level: Tier = 0) {
  if (typeof window === "undefined" || !practice().haptics) return;
  const round = level > 0 && (kind === "win" || kind === "great" || kind === "top") ? (level as 1 | 2 | 3 | 4) : 0;
  try {
    if (typeof navigator.vibrate === "function") {
      navigator.vibrate(round ? WIN_VIBRATE[round] : VIBRATE[kind]);
      return;
    }
    const count = round ? WIN_FLIPS[round] : FLIPS[kind];
    if (!ios() || !count) return;
    // A finger is on the host: its own click plays it, on every iOS from 17.4 on. One buzz: a tap has one click.
    if (performance.now() - armedAt < 1000) {
      owed = true;
      return;
    }
    for (const f of flips) clearTimeout(f);
    flips = [];
    for (let i = 0; i < count; i++) {
      if (i === 0) flip();
      // A roll speeds up a little towards its end, as a top round's does.
      else flips.push(setTimeout(flip, i * (round === 4 ? 80 : 90)));
    }
  } catch {
    /* not on this device */
  }
}

function sounds(kind: Feel, detail?: Detail) {
  if (kind === "hit" || kind === "run" || kind === "big") sound.hit(detail?.multiple ?? 2, detail?.streak ?? 0);
  else if (kind === "win" || kind === "great" || kind === "top") sound.win(detail?.tier ?? 1, detail?.rounds ?? 1, detail?.till ?? false);
  else if (kind === "nope") sound.nope();
  else if (kind === "cash") sound.cash();
}

/*
  One thing at a time, as on the phone (packages/solana-mobile/src/lib/feel.ts). Hits come in bursts (the price runs
  through a stroke and several land in the same second), and played together they smear into noise and a motor that
  never stops. So every moment goes through one queue and plays after the last has had its say, the most important
  first. A burst of one kind becomes one, the biggest of it. Whatever waited too long to still mean something is
  dropped, and a round's result doesn't wait behind a hit. The finger is the exception: a tap is heard and felt the
  instant it lands.
*/
/** `streak`: hits in a row before this one. `tier` and `rounds`: a profitable round's size, and how many in a row. */
type Detail = { multiple?: number; streak?: number; tier?: Tier; rounds?: number; till?: boolean };
const RANK: Record<Feel, number> = { tap: 0, tick: 0, nope: 3, hit: 4, run: 5, big: 6, cash: 7, win: 7, great: 8, top: 9 };
// How long each has the stage before the next may play, ms: a round's chord and its till ring out in full.
const HOLD: Record<Feel, number> = { tap: 0, tick: 0, nope: 220, hit: 240, run: 260, big: 420, cash: 600, win: 900, great: 1300, top: 1900 };
// How long each may wait its turn and still mean something, ms.
const FRESH: Record<Feel, number> = { tap: 0, tick: 0, nope: 400, hit: 700, run: 700, big: 1000, cash: 2000, win: 2000, great: 2500, top: 3000 };
const family = (k: Feel) => (k === "hit" || k === "run" || k === "big" ? "hit" : k === "great" || k === "top" ? "win" : k);

let queue: { kind: Feel; detail?: Detail; at: number }[] = [];
let stageUntil = 0;
let stageRank = -1;
let pump: ReturnType<typeof setTimeout> | null = null;

function next() {
  if (pump) clearTimeout(pump);
  pump = null;
  const now = performance.now();
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
  const d = top.detail;
  haptic(top.kind, d?.tier ? feltLevel(d.tier, d.rounds ?? 1) : 0);
  sounds(top.kind, d);
  if (queue.length) pump = setTimeout(next, HOLD[top.kind]);
}

/** Sound and touch together, which is how nearly everything is felt, in turn. */
export function feel(kind: Feel, detail?: Detail) {
  if (kind === "tap") {
    haptic(kind);
    sound.drop();
    return;
  }
  // The pen's tick: felt only when nothing else is, so drawing never drowns out a win. Touch only: the pen's own
  // sound comes from pen.move.
  if (kind === "tick") {
    if (performance.now() >= stageUntil) haptic(kind);
    return;
  }
  const same = queue.find((q) => family(q.kind) === family(kind));
  if (same) {
    if (RANK[kind] > RANK[same.kind]) same.kind = kind;
    const d = same.detail ?? {};
    same.detail = {
      multiple: Math.max(d.multiple ?? 0, detail?.multiple ?? 0) || undefined,
      streak: Math.max(d.streak ?? 0, detail?.streak ?? 0),
      tier: Math.max(d.tier ?? 0, detail?.tier ?? 0) as Tier,
      rounds: Math.max(d.rounds ?? 0, detail?.rounds ?? 0) || undefined,
      till: d.till || detail?.till,
    };
  } else queue.push({ kind, detail, at: performance.now() });
  next();
}

/** A round that came out ahead, felt and heard by its tier, and a step up for each profitable round in a row. */
export function celebrate(tier: Tier, rounds: number) {
  if (tier === 0) return;
  feel(tier >= 4 ? "top" : tier === 3 ? "great" : "win", { tier, rounds, till: true });
}
