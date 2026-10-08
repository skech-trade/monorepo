import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs/config";
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

const env = rootEnv();
/*
  Which build this is: each deployment's own id on Vercel (a redeploy of the same commit, for a new setting,
  is a new build too), the commit's otherwise, "local" on a laptop. The app compares its own with the one
  /api/version answers, and updates itself (src/lib/update.ts).
*/
if (!process.env.NEXT_PUBLIC_BUILD_ID) env.NEXT_PUBLIC_BUILD_ID = process.env.VERCEL_DEPLOYMENT_ID || process.env.VERCEL_GIT_COMMIT_SHA || "local";

/*
  The paths every chance is priced on (public/dots-lib.bin, 2 MB), asked for by what is in it: /dots-lib.bin?v=<its
  hash>. That address never changes what it answers, so it is kept for a year (headers below) and a return visit
  never fetches it again; a new file is a new address. Served from public/, it was revalidated on every visit.
*/
function libAddress(): string {
  try {
    return `/dots-lib.bin?v=${createHash("sha256").update(readFileSync(join(process.cwd(), "public", "dots-lib.bin"))).digest("hex").slice(0, 16)}`;
  } catch {
    return "/dots-lib.bin";
  }
}
env.NEXT_PUBLIC_DOTS_LIB = libAddress();

/*
  PostHog through our own domain: /ingest is proxied to PostHog's, so an ad
  blocker that knows posthog.com does not drop the events (src/lib/analytics.ts).
*/
const region = (process.env.NEXT_PUBLIC_POSTHOG_REGION ?? env.NEXT_PUBLIC_POSTHOG_REGION) === "eu" ? "eu" : "us";

const nextConfig: NextConfig = {
  devIndicators: false,
  env,
  /*
    Sentry without its debug logging: what withSentryConfig's bundleSizeOptimizations.excludeDebugStatements would
    do, but that only reaches a webpack build, and this one is Turbopack. Not __SENTRY_TRACING__: a define reaches
    the server's bundle too, and would end its traces; the browser's are left out in src/instrumentation-client.ts.
  */
  compiler: { define: { __SENTRY_DEBUG__: false } },
  async rewrites() {
    return [
      { source: "/ingest/static/:path*", destination: `https://${region}-assets.i.posthog.com/static/:path*` },
      { source: "/ingest/array/:path*", destination: `https://${region}-assets.i.posthog.com/array/:path*` },
      { source: "/ingest/:path*", destination: `https://${region}.i.posthog.com/:path*` },
    ];
  },
  // PostHog's API paths end in a slash (/e/); a redirect that strips it would lose the event.
  skipTrailingSlashRedirect: true,
  /*
    On every response. Never inside another site's frame, where a tap could be steered onto a button with money
    behind it (both headers, for browsers old and new); only the QR scanner may ask for the camera. The page's
    full Content-Security-Policy is still report-only, and comes from src/proxy.ts, since it needs a nonce per request.
  */
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=()" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
        ],
      },
      // Only under its versioned address (libAddress above): the bare path stays revalidated, as public/ files are.
      { source: "/dots-lib.bin", has: [{ type: "query", key: "v" }], headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }] },
    ];
  },
};

/*
  Sentry (src/lib/sentry.ts). At build, source maps go up to Sentry and are then removed from the deploy, so a
  stack reads as our source and nobody else can; that needs SENTRY_AUTH_TOKEN in the build's environment
  (Vercel), and without it the build still works, with minified stacks. Events come in through /monitoring on
  our own domain, past ad blockers.
*/
export default withSentryConfig(nextConfig, {
  org: "sketch-trade",
  project: "next-app",
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: !process.env.CI,
  // Dependencies' frames readable too, not only ours.
  widenClientFileUpload: true,
  tunnelRoute: "/monitoring",
  // Marks our bundle, for the filter that drops errors thrown only by extensions (src/instrumentation-client.ts).
  applicationKey: "skech-app",
});
