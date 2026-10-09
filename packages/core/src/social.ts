import type { Stroke } from "./ink";

/** Public social data. Money travels as integer USDC millionths. */
export type SocialWindow = "24h" | "7d" | "30d" | "all";
export type PlayerProfile = { player: string; username: string | null; bio: string; avatar: boolean; joinedAt: number; followers: number; following: number };
export type PlayerStats = { staked: string; settledStake: string; paid: string; owed: string; pnl: string; drawings: number; completed: number; wins: number; biggest: string };
export type DrawingPiece = { betId: string; stroke: Stroke | null; sections: { second: number; lo: string; hi: string; stake: string; rung: number }[]; openAt: number; unit: string; hitMask: number; missMask: number };
export type PublicDrawing = { id: string; player: string; profile: PlayerProfile; at: number; updatedAt: number; stake: string; settledStake: string; paid: string; owed: string; pnl: string; complete: boolean; pieces: DrawingPiece[]; tx: string };
export type LeaderboardRow = { rank: number; profile: PlayerProfile; stats: PlayerStats };
export type SocialActivity = { id: string; kind: "placed" | "settled"; drawing: string; player: string; profile: PlayerProfile; at: number; amount: string; complete: boolean };
export type ProfileResponse = { profile: PlayerProfile; stats: PlayerStats; drawings: PublicDrawing[]; next: string | null; curve: { at: number; pnl: string }[]; badges: string[]; following: boolean };
export type SocialSnapshot = { type: "snapshot"; drawings: PublicDrawing[]; activity: SocialActivity[]; counting: boolean; progress: number };
export type SocialMessage = SocialSnapshot | { type: "drawing"; drawing: PublicDrawing; activity?: SocialActivity } | { type: "profile"; profile: PlayerProfile } | { type: "status"; counting: boolean; progress: number };

export const socialWindows: SocialWindow[] = ["24h", "7d", "30d", "all"];
export const windowStart = (window: SocialWindow, now = Date.now()) => window === "all" ? 0 : now - ({ "24h": 86_400_000, "7d": 604_800_000, "30d": 2_592_000_000 }[window]);
export const playerName = (profile: Pick<PlayerProfile, "player" | "username">) => profile.username ?? `${profile.player.slice(0, 6)}…${profile.player.slice(-4)}`;
export function playerHue(player: string) {
  let hash = 0;
  for (const ch of player) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return ((hash % 360) + 360) % 360;
}

/** EVM addresses ignore case; Solana public keys are case sensitive. */
export const socialPlayer = (player: string) => /^0x[0-9a-f]{40}$/i.test(player) ? player.toLowerCase() : player;
