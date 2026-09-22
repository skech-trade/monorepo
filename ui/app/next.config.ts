import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { NextConfig } from "next";

/**
 * One env file, at the top of the repo.
 *
 * Next reads `.env.local` from its own directory, so a file at the monorepo
 * root is invisible to it: the app came up with no API, no feed and no way to
 * sign in, and every one of those failures looks like a broken feature rather
 * than a missing variable. The services read the root file directly, so this
 * pulls the same file in rather than keeping a second copy here to drift.
 *
 * Only `NEXT_PUBLIC_` names are taken. Anything else in that file is a secret
 * and has no business in a browser bundle.
 */
function rootEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of [".env.local", ".env"]) {
    let text: string;
    try {
      text = readFileSync(join(process.cwd(), "..", "..", name), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const m = /^\s*(NEXT_PUBLIC_[A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      const value = m[2].trim().replace(/^["']|["']$/g, "");
      // A value already in the environment wins, so a one-off run can override.
      if (value && !(m[1] in out) && !process.env[m[1]]) out[m[1]] = value;
    }
  }
  return out;
}

const nextConfig: NextConfig = {
  devIndicators: false,
  env: rootEnv(),
};

export default nextConfig;
