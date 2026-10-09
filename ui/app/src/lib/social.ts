"use client";

import { useSyncExternalStore } from "react";
import type { PlayerProfile, PublicDrawing, SocialAction, SocialActivity, SocialChallenge, SocialMessage } from "@skech/core/social";
import { jitter, SOCIAL_URL, STEADY_MS } from "./endpoints";

/**
 * The community, from the social service (packages/relayer/src/social): requests, signed actions, and one live
 * stream for the page, kept outside React so the canvas can read it every frame without re-rendering anything.
 */

/**
 * A placed piece's stroke, for everyone else's chart: the chain keeps only its hash, and the service keeps the
 * stroke only if it hashes to that. Sent once the relayer has taken the piece; nothing waits on it.
 */
export function publishStroke(betId: string, stroke: string) {
  void fetch(`${SOCIAL_URL}/stroke`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ betId, stroke }), keepalive: true }).catch(() => undefined);
}

export async function socialRequest<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${SOCIAL_URL}${path}`, {
    method: body === undefined ? "GET" : "POST",
    ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
    signal,
  });
  const result = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(result.error ?? "Could not load this right now");
  return result as T;
}

/** A change only the wallet may make: asked for, signed (no prompt), and sent with the same payload. */
export async function socialAction<T>(player: string, action: SocialAction, payload: unknown, sign: (message: string) => Promise<string>) {
  const challenge = await socialRequest<SocialChallenge>("/challenge", { player, action, payload });
  const signature = await sign(challenge.message);
  return socialRequest<T>(`/${action}`, { token: challenge.token, payload, signature });
}

/**
 * A picture chosen for an avatar, drawn again as a 256-pixel square: what is sent is only what the canvas made of
 * it, so nothing else in the file (a photo's place and camera) leaves the phone, and it is small.
 */
export async function avatarFrom(file: File): Promise<string> {
  if (!file.type.startsWith("image/") || file.size > 20_000_000) throw new Error("Choose a picture");
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) throw new Error("This picture could not be read");
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  const c = canvas.getContext("2d");
  if (!c) throw new Error("This picture could not be read");
  c.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 256, 256);
  bitmap.close();
  for (const [type, quality] of [["image/webp", 0.85], ["image/jpeg", 0.85], ["image/jpeg", 0.6]] as const) {
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
    // Safari makes a PNG when asked for WebP: the next kind is tried.
    if (!blob || blob.type !== type || blob.size > 90_000) continue;
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("This picture could not be read"));
      reader.readAsDataURL(blob);
    });
  }
  throw new Error("This picture could not be made small enough");
}

/** `playing`: who is playing now, most recent first. */
export type SocialState = { connected: boolean; counting: boolean; progress: number; drawings: PublicDrawing[]; activity: SocialActivity[]; playing: PlayerProfile[]; profiles: Record<string, PlayerProfile> };
const EMPTY: SocialState = { connected: false, counting: false, progress: 0, drawings: [], activity: [], playing: [], profiles: {} };
let current = EMPTY;
const listeners = new Set<() => void>();
const activityListeners = new Set<(activity: SocialActivity) => void>();
/** Profiles kept for the page: the newest few hundred, and everyone drawing now. */
function publish(next: SocialState) {
  const keys = Object.keys(next.profiles);
  if (keys.length > 500) {
    const keep = new Set([...keys.slice(-400), ...next.drawings.map((d) => d.player), ...next.playing.map((p) => p.player), ...(viewer ? [viewer] : [])]);
    next.profiles = Object.fromEntries(Object.entries(next.profiles).filter(([key]) => keep.has(key)));
  }
  current = next;
  for (const listener of listeners) listener();
}
/** A profile as it now is, everywhere it shows: after "Edit profile" saves, with no reload. */
export function cacheProfile(profile: PlayerProfile) {
  const swap = <T extends { player: string; profile: PlayerProfile }>(x: T) => (x.player === profile.player ? { ...x, profile } : x);
  publish({ ...current, profiles: { ...current.profiles, [profile.player]: profile }, drawings: current.drawings.map(swap), activity: current.activity.map(swap), playing: current.playing.map((p) => (p.player === profile.player ? profile : p)) });
}
export const socialSnapshot = () => current;
export const onSocialActivity = (listener: (activity: SocialActivity) => void) => {
  activityListeners.add(listener);
  return () => {
    activityListeners.delete(listener);
  };
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const useSocial = () => useSyncExternalStore(subscribe, socialSnapshot, () => EMPTY);

/** Drawings on the live feed that moved in the last two minutes: no older ones are kept. */
const LIVE_MS = 120_000;

/** The page's one stream: reconnects with a growing, jittered wait, as the relayer's socket does. */
export function connectSocial() {
  let stopped = false, socket: WebSocket | null = null, retry: ReturnType<typeof setTimeout> | null = null, backoff = 500, openedAt = 0;
  const connect = () => {
    if (stopped) return;
    const url = new URL(`${SOCIAL_URL}/ws`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(url);
    socket = ws;
    ws.onopen = () => {
      openedAt = Date.now();
      publish({ ...current, connected: true });
    };
    ws.onmessage = (event) => {
      let message: SocialMessage;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.type === "snapshot") {
        const profiles = { ...current.profiles };
        for (const d of message.drawings) profiles[d.player] = d.profile;
        for (const a of message.activity) profiles[a.player] ??= a.profile;
        for (const p of message.playing ?? []) profiles[p.player] ??= p;
        publish({ ...current, drawings: message.drawings.slice(0, 80), activity: message.activity.slice(0, 60), playing: message.playing ?? [], profiles, counting: message.counting, progress: message.progress });
      } else if (message.type === "drawing") {
        const d = message.drawing;
        const drawings = [d, ...current.drawings.filter((x) => x.id !== d.id && x.updatedAt > Date.now() - LIVE_MS)].slice(0, 80);
        const activity = message.activity ? [message.activity, ...current.activity.filter((x) => x.id !== message.activity!.id)].slice(0, 60) : current.activity;
        publish({ ...current, drawings, activity, profiles: { ...current.profiles, [d.player]: d.profile } });
        if (message.activity) for (const listener of activityListeners) listener(message.activity);
      } else if (message.type === "profile") {
        const p = message.profile;
        publish({ ...current, profiles: { ...current.profiles, [p.player]: p }, drawings: current.drawings.map((d) => (d.player === p.player ? { ...d, profile: p } : d)), activity: current.activity.map((a) => (a.player === p.player ? { ...a, profile: p } : a)), playing: current.playing.map((x) => (x.player === p.player ? p : x)) });
      } else if (message.type === "presence") {
        const profiles = { ...current.profiles };
        for (const p of message.playing) if (p.username || p.avatar || p.avatarSeed || !profiles[p.player]) profiles[p.player] = p;
        publish({ ...current, playing: message.playing, profiles });
      } else if (message.type === "status") publish({ ...current, counting: message.counting, progress: message.progress });
    };
    ws.onclose = () => {
      if (socket !== ws || stopped) return;
      publish({ ...current, connected: false });
      if (openedAt && Date.now() - openedAt > STEADY_MS) backoff = 500;
      retry = setTimeout(connect, jitter(backoff));
      backoff = Math.min(15_000, backoff * 2);
    };
    ws.onerror = () => ws.close();
  };
  connect();
  return () => {
    stopped = true;
    if (retry) clearTimeout(retry);
    socket?.close();
    publish({ ...current, connected: false });
  };
}

/** Whose ink is drawn on the chart: everyone's, only those followed, or none but one's own. */
export type DrawingAudience = "everyone" | "following" | "me";
let audience: DrawingAudience = "everyone";
let viewer: string | null = null;
let following = new Set<string>();
export function setSocialViewer(player: string | null, targets: string[]) {
  viewer = player;
  following = new Set(targets);
}
export function setDrawingAudience(value: DrawingAudience) {
  audience = value;
}
/** Other players' drawings on the chart now. */
export function remoteDrawings() {
  if (audience === "me" || !current.connected) return [];
  return current.drawings.filter((d) => d.player !== viewer && d.updatedAt > Date.now() - LIVE_MS && (audience === "everyone" || following.has(d.player)));
}
/** Every drawing the chart may label, the viewer's own included. */
export function visibleSocialDrawings() {
  if (!current.connected) return [];
  return current.drawings.filter((d) => d.updatedAt > Date.now() - LIVE_MS && (d.player === viewer || (audience !== "me" && (audience === "everyone" || following.has(d.player)))));
}
export function openPlayerProfile(player: string) {
  window.dispatchEvent(new CustomEvent("skech:profile", { detail: player }));
}
export function openDrawing(id: string) {
  window.dispatchEvent(new CustomEvent("skech:drawing", { detail: id }));
}

/** USDC millionths as dollars, never through a float. */
export function socialMoney(value: string, signed = false): string {
  const amount = BigInt(value), abs = amount < 0n ? -amount : amount;
  const rounded = (abs + 5000n) / 10_000n;
  const dollars = rounded / 100n, cents = (rounded % 100n).toString().padStart(2, "0");
  return `${rounded === 0n ? "" : amount < 0n ? "−" : signed ? "+" : ""}$${dollars.toLocaleString("en-US")}${cents === "00" ? "" : `.${cents}`}`;
}
