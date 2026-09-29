import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { NextConfig } from "next";
import { chainIdFor, networkOf, network } from "../../packages/core/src/network";

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
  // The chain settings every service reads, the same way: the environment first, then the file.
  const chain: Record<string, string | undefined> = { SKECH_NETWORK: process.env.SKECH_NETWORK, ENGINE_CHAIN_ID: process.env.ENGINE_CHAIN_ID, SKECH_GAME: process.env.SKECH_GAME };
  for (const name of [".env.local", ".env"]) {
    let text: string;
    try {
      text = readFileSync(join(process.cwd(), "..", "..", name), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const setting = /^\s*(SKECH_NETWORK|ENGINE_CHAIN_ID|SKECH_GAME)\s*=\s*(.*)$/.exec(line);
      if (setting && !chain[setting[1]]) chain[setting[1]] = setting[2].trim().replace(/^["']|["']$/g, "") || undefined;
      const m = /^\s*(NEXT_PUBLIC_[A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      // The chain's own values come from the switch below, never from the file: one left from the other network would win.
      if (m && /^NEXT_PUBLIC_SKECH_(NETWORK|CHAIN_ID|GAME|USDC)$/.test(m[1])) continue;
      if (!m) continue;
      const value = m[2].trim().replace(/^["']|["']$/g, "");
      // A value already in the environment wins, so a one-off run can override.
      if (value && !(m[1] in out) && !process.env[m[1]]) out[m[1]] = value;
    }
  }
  return { ...out, ...chainEnv(chain) };
}

/**
 * The chain, from the one switch. SKECH_NETWORK names the network, and the deploy's file names the game on
 * it, so the app can never be on one network while its game address is from the other. These are not taken
 * from .env.local; a value in the environment still wins, for a one-off run.
 */
function chainEnv(settings: Record<string, string | undefined>): Record<string, string> {
  // The same resolution as the engine, the relayer and the dev script: SKECH_NETWORK picks the chain,
  // ENGINE_CHAIN_ID overrides it for anvil, SKECH_GAME overrides the deployment file's game.
  const chainId = chainIdFor(settings);
  const net = networkOf(chainId) ?? network(settings.SKECH_NETWORK);
  const file = join(process.cwd(), "..", "..", "packages", "contracts", "deployments", `${chainId}.json`);
  const deployed = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { game?: string; usdc?: string }) : {};
  const out: Record<string, string> = {
    NEXT_PUBLIC_SKECH_NETWORK: net.name,
    NEXT_PUBLIC_SKECH_CHAIN_ID: String(chainId),
    NEXT_PUBLIC_SKECH_USDC: deployed.usdc ?? net.usdc,
  };
  // No game on this chain yet: the app plays for practice.
  const game = settings.SKECH_GAME ?? deployed.game;
  if (game) out.NEXT_PUBLIC_SKECH_GAME = game;
  for (const key of Object.keys(out)) if (process.env[key]) delete out[key];
  return out;
}

const nextConfig: NextConfig = {
  devIndicators: false,
  env: rootEnv(),
};

export default nextConfig;
