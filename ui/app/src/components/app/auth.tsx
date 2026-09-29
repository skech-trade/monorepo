"use client";

import { useCurrentUser, useEvmAddress, useIsInitialized, useIsSignedIn, useSignEvmMessage, useSignEvmTypedData, useSignOut } from "@coinbase/cdp-hooks";
import { CDPReactProvider, type Config, type Theme } from "@coinbase/cdp-react";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useRef, useState } from "react";
import { identify, track } from "@/lib/analytics";
import { shortAddress } from "@/lib/market";

/**
 * Signing in.
 *
 * Coinbase embedded wallets: email, phone or Google, no extension to install
 * and no seed phrase to write down. The wallet is an EOA rather than a smart
 * account, so it can sign a plain message off chain.
 *
 * With no project id configured the app runs signed out and everything else
 * still works, which is what the tests and screenshots use. Coinbase's hooks
 * only work inside their provider, so they are read in one component that
 * only mounts there and published through context; everyone else reads the
 * context and calls exactly one hook however the build is configured.
 */

const PROJECT = process.env.NEXT_PUBLIC_CDP_PROJECT_ID ?? "";

/** Whether this build can sign anyone in at all. */
export const hasAuth = PROJECT !== "";

const config: Config = {
  projectId: PROJECT,
  appName: "skech",
  /*
    Off: the SDK reports sign-in events to Coinbase with a fetch it never
    catches, so wherever that is blocked (an ad blocker, say) every token
    refresh left an unhandled "Failed to fetch" on the page.
  */
  disableAnalytics: true,
  /*
    Whatever someone already has. The SDK's own union is "email" and "sms"
    plus `oauth:` with google, apple, x, telegram or github; each one still
    has to be turned on in the CDP Portal or its button never appears.
  */
  authMethods: ["email", "sms", "oauth:google", "oauth:apple"],
  ethereum: { createOnLogin: "eoa" },
};

export type Account = {
  /**
   * Whether Coinbase has finished reading the saved session. Until it has, `signedIn` is false for everyone,
   * someone signed in included: that is not knowing yet, not signed out, and nothing may ask them to sign in.
   */
  ready: boolean;
  signedIn: boolean;
  /** The wallet's address, once there is one. */
  address: string | null;
  /** Whatever they signed in with, for the greeting. */
  handle: string | null;
  signOut: () => void;
  /**
   * Sign a plain message with the wallet.
   *
   * Published through this context like everything
   * else, so a screen can ask for a signature without knowing whether
   * Coinbase's provider is mounted.
   */
  signMessage: (message: string) => Promise<string | null>;
  /**
   * Sign EIP-712 typed data with the wallet: a session, a deposit's permit,
   * a withdrawal. The wallet signs in its enclave with no prompt, so the
   * values must be plain JSON: bigints go in as decimal strings.
   */
  signTypedData: (typedData: TypedDataToSign) => Promise<`0x${string}` | null>;
};

export type TypedDataToSign = {
  domain: { name: string; version: string; chainId: number; verifyingContract: `0x${string}` };
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
};

/** Bigints as decimal strings, all the way down: what the wallet's signer takes. */
const plain = (v: unknown): unknown =>
  typeof v === "bigint" ? v.toString() : Array.isArray(v) ? v.map(plain) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, plain(x)])) : v;

/** The longest the app waits for Coinbase to read a saved session before treating someone as signed out. */
const READY_WITHIN_MS = 8000;

const SIGNED_OUT: Account = { ready: true, signedIn: false, address: null, handle: null, signOut: () => undefined, signMessage: async () => null, signTypedData: async () => null };
const Ctx = createContext<Account>(SIGNED_OUT);

/** Reads Coinbase's hooks. Only ever mounted inside their provider. */
function Publish({ children }: { children: ReactNode }) {
  const { isInitialized } = useIsInitialized();
  // If Coinbase cannot be reached at all (blocked, offline), it never says; after a while, stop waiting and let them sign in.
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setWaited(true), READY_WITHIN_MS);
    return () => clearTimeout(t);
  }, []);
  const { isSignedIn } = useIsSignedIn();
  // Who is playing, for analytics: the wallet once known. Signed in is counted only when it happens in this visit,
  // not each time a saved session is read back; signed out likewise.
  const ready = Boolean(isInitialized) || waited;
  const { evmAddress } = useEvmAddress();
  const was = useRef<"in" | "out" | null>(null);
  useEffect(() => {
    if (!ready) return;
    if (isSignedIn && evmAddress) {
      identify(evmAddress);
      if (was.current === "out") track("signed_in");
      was.current = "in";
    } else if (!isSignedIn) {
      if (was.current === "in") {
        track("signed_out");
        identify(null);
      }
      was.current = "out";
    }
  }, [ready, isSignedIn, evmAddress]);
  const { currentUser } = useCurrentUser();
  const { signOut } = useSignOut();
  const { signEvmMessage } = useSignEvmMessage();
  const { signEvmTypedData } = useSignEvmTypedData();
  const user = currentUser as { authenticationMethods?: { email?: { email?: string }; sms?: { phoneNumber?: string } } } | null;
  const account = useMemo<Account>(() => {
    const handle = user?.authenticationMethods?.email?.email ?? user?.authenticationMethods?.sms?.phoneNumber ?? (evmAddress ? shortAddress(evmAddress) : null);
    return {
      ready,
      signedIn: Boolean(isSignedIn),
      address: evmAddress ?? null,
      handle,
      signOut: () => void signOut(),
      signMessage: async (message: string) => {
        if (!evmAddress) return null;
        const { signature } = await signEvmMessage({ evmAccount: evmAddress, message });
        return signature;
      },
      signTypedData: async (typedData) => {
        if (!evmAddress) return null;
        const types = {
          EIP712Domain: [
            { name: "name", type: "string" },
            { name: "version", type: "string" },
            { name: "chainId", type: "uint256" },
            { name: "verifyingContract", type: "address" },
          ],
          ...typedData.types,
        };
        const { signature } = await signEvmTypedData({ evmAccount: evmAddress, typedData: { domain: typedData.domain, types, primaryType: typedData.primaryType, message: plain(typedData.message) as Record<string, unknown> } });
        return signature as `0x${string}`;
      },
    };
  }, [ready, isSignedIn, evmAddress, user, signOut, signEvmMessage, signEvmTypedData]);
  return <Ctx.Provider value={account}>{children}</Ctx.Provider>;
}

/**
 * Coinbase's panel, in our colours.
 *
 * Every value is one of our own CSS variables rather than a hex, so the panel
 * follows the theme switch for free: the variables are redefined under `.dark`
 * and the panel is reading them live. Handing it two palettes to choose
 * between would mean keeping them in step by hand for ever.
 */
const theme: Partial<Theme> = {
  "colors-bg-default": "var(--popover)",
  "colors-bg-alternate": "var(--muted)",
  "colors-bg-overlay": "rgb(0 0 0 / 0.32)",
  "colors-bg-skeleton": "var(--muted)",
  "colors-bg-primary": "var(--primary)",
  "colors-bg-secondary": "var(--secondary)",
  "colors-fg-default": "var(--foreground)",
  "colors-fg-muted": "var(--muted-foreground)",
  "colors-fg-primary": "var(--brand)",
  "colors-fg-onPrimary": "var(--primary-foreground)",
  "colors-fg-onSecondary": "var(--secondary-foreground)",
  "colors-fg-positive": "var(--up)",
  "colors-fg-negative": "var(--down)",
  "colors-line-default": "var(--border)",
  "colors-line-heavy": "var(--input)",
  "colors-line-primary": "var(--brand)",
  "colors-page-bg-default": "var(--popover)",
  "colors-page-border-default": "var(--border)",
  "colors-page-text-default": "var(--foreground)",
  "colors-page-text-muted": "var(--muted-foreground)",
  /* The one filled button on this screen is the ballpoint blue the line is
     drawn in, so Coinbase's Continue is that blue too. */
  "colors-cta-primary-bg-default": "var(--brand)",
  "colors-cta-primary-bg-hover": "color-mix(in srgb, var(--brand) 88%, black)",
  "colors-cta-primary-bg-pressed": "color-mix(in srgb, var(--brand) 78%, black)",
  "colors-cta-primary-text-default": "#ffffff",
  "colors-cta-primary-text-hover": "#ffffff",
  "colors-cta-secondary-bg-default": "var(--muted)",
  "colors-cta-secondary-bg-hover": "var(--accent)",
  "font-family-sans": "var(--font-sans), ui-sans-serif, system-ui, sans-serif",
  /*
    And our corners. The panel came with Coinbase's rounding, which is square
    beside a screen where every panel is an 18px curve and every button is a
    pill. Same trick as the colours: our variables, so one change moves both.
  */
  "borderRadius-xs": "var(--radius-sm)",
  "borderRadius-sm": "var(--radius-md)",
  "borderRadius-md": "var(--radius-lg)",
  "borderRadius-lg": "var(--radius-xl)",
  "borderRadius-xl": "var(--radius-2xl)",
  "borderRadius-modal": "var(--radius-2xl)",
  "borderRadius-input": "var(--radius-xl)",
  "borderRadius-cta": "9999px",
  "borderRadius-badge": "9999px",
  "borderRadius-banner": "var(--radius-xl)",
  "borderRadius-select-trigger": "var(--radius-xl)",
  "borderRadius-select-list": "var(--radius-2xl)",
};

export function AuthProvider({ children }: { children: ReactNode }) {
  if (!hasAuth) return <Ctx.Provider value={SIGNED_OUT}>{children}</Ctx.Provider>;
  return (
    <CDPReactProvider config={config} theme={theme}>
      <Publish>{children}</Publish>
    </CDPReactProvider>
  );
}

/** Who is signed in. Answers signed out rather than throwing where there is no auth. */
export function useAccount(): Account {
  return useContext(Ctx);
}
