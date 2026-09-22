import { buddyArtwork } from "./buddy-art";
/** One set of options feeds the preview, image and recorded clip. */
export type ShareStyle = { theme: "night" | "paper"; buddy: "blue" | "mint" | "coral"; showMoney: boolean };
export const DEFAULT_SHARE_STYLE: ShareStyle = { theme: "night", buddy: "blue", showMoney: true };
export const BUDDY_COLORS = { blue: "#5b8cff", mint: "#4ade80", coral: "#fb7185" };

/** Keep the person mascot identical across onboarding, cards and clips. */
export function paintBuddy(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, cheerful: boolean, frame: number) {
  ctx.save();
  ctx.translate(x - 50, y - 65 - Math.sin(frame * Math.PI) * 5);
  for (const part of buddyArtwork(color, cheerful)) {
    ctx.globalAlpha = part.opacity ?? 1;
    const path = new Path2D(part.d);
    if (part.fill) { ctx.fillStyle = part.fill; ctx.fill(path); }
    if (part.stroke) { ctx.strokeStyle = part.stroke; ctx.lineWidth = part.width ?? 1; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.stroke(path); }
  }
  ctx.restore();
}
