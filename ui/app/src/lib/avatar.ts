import { Avatar, Style } from "@dicebear/core";
import dylan from "@dicebear/styles/dylan.json" with { type: "json" };
import { avatarSeedOf, type PlayerProfile } from "@skech/core/social";
import { SOCIAL_URL } from "./endpoints";

/**
 * Everyone's face: a "Dylan" avatar (DiceBear), seeded by the one they chose or by their address, or a picture
 * they uploaded. Made once per seed, as an SVG data URI (img-src data: in the page's policy), and kept.
 *
 * Avatars: "Dylan" by Natalia Spivak, CC BY 4.0 (AVATAR_CREDIT).
 */
export const AVATAR_CREDIT = {
  text: "Avatars: “Dylan” by Natalia Spivak, CC BY 4.0",
  source: "https://www.figma.com/community/file/1356575240759683500",
  licence: "https://creativecommons.org/licenses/by/4.0/",
};

let style: Style<unknown> | null = null;
const made = new Map<string, string>();

/** The Dylan avatar for a seed, as a data URI: made once, then from memory (at most a few thousand kept). */
export function dylanUri(seed: string): string {
  let uri = made.get(seed);
  if (uri) return uri;
  style ??= new Style(dylan);
  uri = new Avatar(style, { seed }).toDataUri();
  if (made.size >= 2000) made.delete(made.keys().next().value!);
  made.set(seed, uri);
  return uri;
}

/** A player's face: their uploaded picture, else their Dylan avatar. */
export const faceOf = (profile: Pick<PlayerProfile, "player" | "avatar" | "avatarSeed">) => (profile.avatar ? `${SOCIAL_URL}/avatar?player=${encodeURIComponent(profile.player)}` : dylanUri(avatarSeedOf(profile)));

/** The Dylan avatars offered when choosing: `<address>:<n>`, a page of them from `from`. */
export const avatarChoices = (player: string, from: number, count = 9) => Array.from({ length: count }, (_, i) => `${player}:${from + i}`);
