import type { Stroke } from "./ink";

/**
 * The community's public data: profiles, follows, drawings and what they made, as the social service serves them
 * (packages/relayer/src/social). Players are Solana addresses, base58 and case sensitive. Money is integer USDC
 * millionths, as decimal strings.
 */
export type SocialWindow = "24h" | "7d" | "30d" | "all";
export type PlayerProfile = { player: string; username: string | null; bio: string; avatar: boolean; joinedAt: number; followers: number; following: number };
export type PlayerStats = { staked: string; settledStake: string; paid: string; owed: string; pnl: string; drawings: number; completed: number; wins: number; biggest: string };
export type DrawingPiece = { betId: string; stroke: Stroke | null; sections: { second: number; lo: string; hi: string; stake: string; rung: number }[]; openAt: number; unit: string; hitMask: number; missMask: number; expiredMask?: number };
export type PublicDrawing = { id: string; player: string; profile: PlayerProfile; at: number; updatedAt: number; stake: string; settledStake: string; paid: string; owed: string; pnl: string; complete: boolean; pieces: DrawingPiece[]; tx: string };
export type LeaderboardRow = { rank: number; profile: PlayerProfile; stats: PlayerStats };
export type SocialActivity = { id: string; kind: "placed" | "settled"; drawing: string; player: string; profile: PlayerProfile; at: number; amount: string; complete: boolean };
export type ProfileResponse = { profile: PlayerProfile; stats: PlayerStats; drawings: PublicDrawing[]; next: string | null; curve: { at: number; pnl: string }[]; badges: string[]; following: boolean };
export type SocialSnapshot = { type: "snapshot"; drawings: PublicDrawing[]; activity: SocialActivity[]; counting: boolean; progress: number };
export type SocialMessage = SocialSnapshot | { type: "drawing"; drawing: PublicDrawing; activity?: SocialActivity } | { type: "profile"; profile: PlayerProfile } | { type: "status"; counting: boolean; progress: number };
/** What a signed action asks: the service answers it with a challenge for the wallet to sign. */
export type SocialAction = "profile" | "follow";
export type SocialChallenge = { token: string; message: string };

export const socialWindows: SocialWindow[] = ["24h", "7d", "30d", "all"];
export const windowStart = (window: SocialWindow, now = Date.now()) => (window === "all" ? 0 : now - { "24h": 86_400_000, "7d": 604_800_000, "30d": 2_592_000_000 }[window]);
export const playerName = (profile: Pick<PlayerProfile, "player" | "username">) => profile.username ?? `${profile.player.slice(0, 4)}…${profile.player.slice(-4)}`;
export function playerHue(player: string) {
  let hash = 0;
  for (const ch of player) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return ((hash % 360) + 360) % 360;
}

/** A Solana address as text: 32 to 44 base58 characters. The service decodes it to 32 bytes before trusting it. */
export const looksLikePlayer = (value: unknown): value is string => typeof value === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);

/* ---- what a profile may say: the service checks it, and the app says the same before asking ---- */

export const USERNAME = /^[a-z][a-z0-9_]{2,23}$/;
export const BIO_MAX = 160;
/** Names that would read as the game speaking. */
const RESERVED = new Set(["admin", "administrator", "skech", "skech_trade", "support", "help", "official", "moderator", "mod", "staff", "team", "system", "root", "oracle", "relayer", "house", "null", "undefined"]);
/** Control characters, zero-width and direction overrides: text that hides or reorders what it says. */
const HIDDEN = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F­​-‏‪-‮⁠-⁩﻿]/;

/** Why a username is refused, or null. */
export function usernameProblem(username: unknown): string | null {
  if (typeof username !== "string" || !USERNAME.test(username)) return "Use 3–24 lowercase letters, numbers or underscores; start with a letter";
  if (RESERVED.has(username) || username.startsWith("skech")) return "That username is reserved";
  return null;
}

/** The bio as kept: trimmed and normalised. Throws with why it cannot be. */
export function cleanBio(bio: unknown): string {
  if (typeof bio !== "string") throw new Error("Invalid bio");
  const text = bio.normalize("NFC").replace(/\r\n?/g, "\n").trim();
  if ([...text].length > BIO_MAX) throw new Error(`Keep your bio under ${BIO_MAX} characters`);
  if (HIDDEN.test(text)) throw new Error("Your bio has characters that cannot be shown");
  if ((text.match(/\n/g)?.length ?? 0) > 4) throw new Error("Keep your bio to five lines");
  return text;
}
