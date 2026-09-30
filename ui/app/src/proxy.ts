import { createHash } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { ENGINE_URL, RELAYER_URL, RPC_URL } from "@/lib/endpoints";
import { SENTRY_DSN } from "@/lib/sentry";
import { THEME_BOOT } from "@/lib/theme-boot";

/*
  The page's Content-Security-Policy, reported and not yet enforced: once the reports (in Sentry, when it is
  on) show nothing the app needs is outside it, the header becomes Content-Security-Policy and it is enforced.
  The other headers, framing included, are enforced already (next.config.ts).

  Scripts are allowed by a nonce made for each request, not by a list of hashes: Next streams each page's data
  in inline scripts whose text changes every render, and it puts this nonce on them, and on its own script tags,
  when it finds it in the request's policy. The one inline script of our own, the theme's, is allowed by its hash.

  Coinbase's sign-in, read from its SDK: its API (api.cdp.coinbase.com), the iframe that holds the wallet's key
  (secure-wallet.cdp.coinbase.com), and the fonts its stylesheet imports from Google. Google and Apple sign-in
  are a redirect, which no directive here covers. Its analytics host (cca-lite.coinbase.com) is left out: the
  app turns them off (src/components/app/auth.tsx).
*/

const THEME_HASH = `'sha256-${createHash("sha256").update(THEME_BOOT).digest("base64")}'`;
const origin = (url: string) => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};
/** Sentry's own endpoint for policy reports, from the DSN: https://KEY@HOST/PROJECT reports to HOST/api/PROJECT/security. */
const REPORT_URI = (() => {
  try {
    const dsn = new URL(SENTRY_DSN);
    return `${dsn.origin}/api${dsn.pathname}/security/?sentry_key=${dsn.username}`;
  } catch {
    return null;
  }
})();

function policy(nonce: string) {
  const dev = process.env.NODE_ENV === "development";
  const connect = ["'self'", ...new Set([ENGINE_URL, RELAYER_URL, RPC_URL].map(origin).filter(Boolean)), "https://api.cdp.coinbase.com"];
  return [
    "default-src 'self'",
    // React rebuilds server error stacks with eval in development only.
    `script-src 'self' 'nonce-${nonce}' ${THEME_HASH}${dev ? " 'unsafe-eval'" : ""}`,
    // Inline styles are React's style props and the sign-in panel's theme, not injected markup.
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    // /ingest (PostHog), /monitoring (Sentry) and /api are this origin.
    `connect-src ${connect.join(" ")}`,
    "frame-src https://secure-wallet.cdp.coinbase.com",
    // The map's worker is ours; Sentry's replay compresses in a worker made from a blob.
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(REPORT_URI ? [`report-uri ${REPORT_URI}`] : []),
  ].join("; ");
}

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = policy(nonce);
  // On the request, so the render finds the nonce; on the response, for the browser.
  const headers = new Headers(request.headers);
  headers.set("Content-Security-Policy-Report-Only", csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy-Report-Only", csp);
  return response;
}

// Pages only: not the build's files, the proxied analytics and error routes, the API, or anything with an extension.
export const config = {
  matcher: [
    {
      source: "/((?!_next/|ingest/|monitoring|api/|.*\\.[a-z0-9]+$).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
