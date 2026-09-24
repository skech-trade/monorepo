import { useSyncExternalStore } from "react";

/**
 * What the reader has set, kept in this browser.
 *
 * One store for every preference, so nothing is forgotten between visits and
 * there is one place to look. It lives in localStorage until there are
 * accounts to hang it on.
 */

/** Green and red, or blue and orange for readers who cannot separate the two. */
export type Palette = "classic" | "colourblind";
export type Settings = {
  palette: Palette;
  /** Blur every figure, for reading the screen in company. */
  blurred: boolean;
};

export const DEFAULTS: Settings = {
  palette: "classic",
  blurred: false,
};

const KEY = "skech:settings";

let current: Settings | null = null;
const listeners = new Set<() => void>();

function read(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    // Spread over the defaults so a setting added later arrives set, rather
    // than undefined, for everyone who already has a stored object.
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

function snapshot(): Settings {
  if (current === null) current = read();
  return current;
}

/** The server has no browser to read, so it renders the defaults and React swaps them in after. */
function serverSnapshot(): Settings {
  return DEFAULTS;
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  // Another tab of the same app is the same reader, so follow it.
  const onStorage = (e: StorageEvent) => {
    if (e.key !== KEY) return;
    current = null;
    for (const l of listeners) l();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

/** The palette rides on `<html>`, where the boot script can set it before the first paint. */
function paint(s: Settings) {
  document.documentElement.dataset.palette = s.palette;
}

export function setSettings(patch: Partial<Settings>) {
  current = { ...snapshot(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // Private mode. The change still holds for this page.
  }
  paint(current);
  for (const l of listeners) l();
}

export function useSettings(): [Settings, typeof setSettings] {
  return [useSyncExternalStore(subscribe, snapshot, serverSnapshot), setSettings];
}
