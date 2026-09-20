import { type Market, signedUsd, usd } from "@/lib/market";
import { verdictWord } from "@/lib/sketch";
import { HANDLE } from "@/lib/user";
import type { Sketch } from "./sketches";

/** A run of text, set in the sans or in figures. */
export type Seg = { text: string; mono?: boolean };

const WORDS = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

/** The clause after "put $470 on Bitcoin going down at 10×": what the market did about it. */
function happened(sketch: Sketch): Seg[] {
  const pct = { text: `${Math.round((sketch.right ?? 0) * 100)}%`, mono: true };
  switch (sketch.outcome) {
    case "target":
      return sketch.net >= 0 ? [{ text: " and it went exactly there" }] : [{ text: " and it got there, just not far enough to cover the fees" }];
    case "stop":
      return [{ text: " and it hit the stop first" }];
    case "liquidated":
      return [{ text: " and it ran the other way" }];
    case "closed":
      return [{ text: " and took it off " }, pct, { text: " of the way in" }];
    default:
      return [{ text: " and it stayed with the line " }, pct, { text: " of the way" }];
  }
}

/** The one sentence on the card. Third person, because the card is for other people. Runs long on purpose. */
export function cardStory(sketch: Sketch, market: Market, streak = 0): Seg[] {
  const out: Seg[] = [
    { text: `${HANDLE} put ` },
    { text: `$${usd(sketch.stake, 0)}`, mono: true },
    { text: ` on ${market.name} going ${sketch.long ? "up" : "down"} at ` },
    { text: `${sketch.leverage}×`, mono: true },
    ...happened(sketch),
  ];
  if (streak >= 2 && sketch.net >= 0) out.push({ text: `, ${streak < WORDS.length ? WORDS[streak] : streak} in a row` });
  out.push({ text: "." });
  return out;
}

/** What goes in the post. First person, since you are the one posting it. */
export function postText(sketch: Sketch, market: Market, streak = 0): string {
  const word = verdictWord(sketch.outcome ?? "time", sketch.right ?? 0, sketch.net);
  const opener = word === "Called it" || word === "Wiped out" ? `${word}. ` : "";
  const body = cardStory(sketch, market, streak)
    .map((s) => s.text)
    .join("")
    .replace(`${HANDLE} put`, "Put");
  return `${opener}${body} ${signedUsd(sketch.net)} on skech.\n\nskech.trade`;
}
