// Runs before the app is interactive: analytics and error capture start here, so a crash on load is still seen.
import * as Sentry from "@sentry/nextjs";
import { SIGN_IN_PANEL, startAnalytics, whenIdle } from "@/lib/analytics";
import { SENTRY_APP_KEY, SENTRY_DATA, SENTRY_DSN, SENTRY_ENVIRONMENT, SENTRY_ON, SENTRY_TRACES } from "@/lib/sentry";

try {
  const nav = navigator as Navigator & { standalone?: boolean };
  Sentry.init({
    dsn: SENTRY_DSN,
    enabled: SENTRY_ON,
    environment: SENTRY_ENVIRONMENT,
    tracesSampleRate: SENTRY_TRACES,
    // No replay of a visit that went fine; the last minute before every error.
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 1,
    dataCollection: SENTRY_DATA,
    integrations: [
      // An error whose every frame is outside our bundle is an extension's or an injected script's, not ours.
      Sentry.thirdPartyErrorFilterIntegration({ filterKeys: [SENTRY_APP_KEY], behaviour: "drop-error-if-exclusively-contains-third-party-frames" }),
    ],
    ignoreErrors: [
      // The browser's notice that a resize took two frames, harmless and everywhere.
      "ResizeObserver loop limit exceeded",
      "ResizeObserver loop completed with undelivered notifications",
    ],
    denyUrls: [/^chrome-extension:\/\//, /^moz-extension:\/\//, /^safari-(web-)?extension:\/\//],
    // On every error: which network, and whether it was opened from the Home Screen.
    initialScope: {
      tags: {
        network: process.env.NEXT_PUBLIC_SKECH_NETWORK ?? "testnet",
        standalone: Boolean(nav.standalone) || matchMedia("(display-mode: standalone)").matches,
      },
    },
  });
  /*
    The replay's recorder is most of what Sentry weighs (about 165 KB gzipped): added once the page has painted
    and the browser is idle, not before the game can be seen. An error before then is sent without a replay.
    What is typed (the sign-in email, its code, an amount) is never in a replay, nor who is playing
    (src/lib/analytics.ts).
  */
  if (SENTRY_ON)
    whenIdle(
      () =>
        void import("@sentry/nextjs").then(
          ({ replayIntegration }) => Sentry.addIntegration(replayIntegration({ maskAllText: false, maskAllInputs: true, blockAllMedia: false, mask: [SIGN_IN_PANEL] })),
          () => undefined,
        ),
    );
} catch {
  // Nor is error capture.
}

try {
  startAnalytics();
} catch {
  // Analytics must never be the reason the game does not open.
}

// Each navigation as a trace, named for its route.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
