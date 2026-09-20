const TOKENS = {
  up: "--up",
  upMark: "--up-mark",
  down: "--down",
  downMark: "--down-mark",
  brand: "--brand",
  warning: "--warning-foreground",
  fg: "--foreground",
  fgMuted: "--muted-foreground",
  fgSubtle: "--muted-foreground",
  bg: "--background",
  surface: "--card",
  surface2: "--muted",
  surface3: "--input",
  grid: "--border",
  hairline: "--border",
} as const;

export type Palette = Record<keyof typeof TOKENS, string> & {
  upSoft: string;
  downSoft: string;
};

const FALLBACK: Record<keyof typeof TOKENS, string> = {
  up: "#047857",
  upMark: "#10b981",
  down: "#b91c1c",
  downMark: "#ef4444",
  brand: "#3b82f6",
  warning: "#b45309",
  fg: "#262626",
  fgMuted: "#6b6b6b",
  fgSubtle: "#6b6b6b",
  bg: "#ffffff",
  surface: "#ffffff",
  surface2: "#f5f5f5",
  surface3: "#e5e5e5",
  grid: "#ebebeb",
  hairline: "#ebebeb",
};

const SENTINEL = "#010203";
const hex2 = (n: number) => n.toString(16).padStart(2, "0");

function resolver(): (value: string, fallback: string, over?: [number, number, number]) => string {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return (_value, fallback) => fallback;

  return (value, fallback, over = [255, 255, 255]) => {
    const trimmed = value.trim();
    if (!trimmed) return fallback;
    ctx.fillStyle = SENTINEL;
    try {
      ctx.fillStyle = trimmed;
    } catch {
      return fallback;
    }
    if (ctx.fillStyle === SENTINEL) return fallback;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    // Alpha tokens (border, muted) are painted over the page white, so the
    // chart gets the colour the eye sees rather than a transparent grey.
    if (a < 255) {
      const k = a / 255;
      const mix = (c: number, o: number) => Math.round(c * k + o * (1 - k));
      return `#${hex2(mix(r, over[0]))}${hex2(mix(g, over[1]))}${hex2(mix(b, over[2]))}`;
    }
    return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
  };
}

function alpha(color: string, a: number): string {
  const parsed = /^#([0-9a-f]{6})$/i.exec(color);
  if (!parsed) return color;
  const n = Number.parseInt(parsed[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

export function readPalette(): Palette {
  const resolve = resolver();
  const style = getComputedStyle(document.documentElement);
  // The page ground first, so alpha tokens composite over it in either theme.
  const bg = resolve(style.getPropertyValue("--background"), FALLBACK.bg);
  const n = Number.parseInt(bg.slice(1), 16);
  const over: [number, number, number] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const out = {} as Record<keyof typeof TOKENS, string>;
  for (const key of Object.keys(TOKENS) as (keyof typeof TOKENS)[]) {
    out[key] = resolve(style.getPropertyValue(TOKENS[key]), FALLBACK[key], over);
  }
  return { ...out, upSoft: alpha(out.upMark, 0.32), downSoft: alpha(out.downMark, 0.32) };
}

let cached: Palette | null = null;

export function paletteSnapshot(): Palette {
  if (cached === null) cached = readPalette();
  return cached;
}

/** Null through the server render and hydration, so the two agree. */
export function paletteServerSnapshot(): Palette | null {
  return null;
}

export function subscribePalette(onChange: () => void): () => void {
  const invalidate = () => {
    cached = null;
    onChange();
  };
  const observer = new MutationObserver(invalidate);
  // The class carries the theme, `data-palette` the colour pair. The canvas
  // charts read their colours out of CSS, so both have to invalidate them.
  observer.observe(document.documentElement, { attributeFilter: ["class", "data-palette"], attributes: true });
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", invalidate);
  return () => {
    observer.disconnect();
    media.removeEventListener("change", invalidate);
  };
}
