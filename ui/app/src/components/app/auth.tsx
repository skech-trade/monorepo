"use client";

import { useCurrentUser, useEvmAddress, useIsSignedIn, useSignEvmMessage, useSignOut } from "@coinbase/cdp-hooks";
import { CDPReactProvider, type Config, type Theme } from "@coinbase/cdp-react";
import { createContext, type ReactNode, useContext, useMemo } from "react";

/**
 * Signing in.
 *
 * Coinbase embedded wallets: email, phone or Google, no extension to install
 * and no seed phrase to write down. The wallet is an EOA rather than a smart
 * account because Lighter registers a trading key by asking the wallet to
 * sign one plain message, and a contract wallet cannot sign one off chain.
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
    Whatever someone already has. The SDK's own union is "email" and "sms"
    plus `oauth:` with google, apple, x, telegram or github; each one still
    has to be turned on in the CDP Portal or its button never appears.
  */
  authMethods: ["email", "sms", "oauth:google", "oauth:apple"],
  ethereum: { createOnLogin: "eoa" },
};

export type Account = {
  signedIn: boolean;
  /** The wallet's address, once there is one. */
  address: string | null;
  /** Whatever they signed in with, for the greeting. */
  handle: string | null;
  signOut: () => void;
  /**
   * Sign a plain message with the wallet.
   *
   * Registering a trading key needs it: Lighter hands back a message that
   * says which key, on which account, and only the wallet that owns the
   * account can agree to it. Published through this context like everything
   * else, so a screen can ask for a signature without knowing whether
   * Coinbase's provider is mounted.
   */
  signMessage: (message: string) => Promise<string | null>;
};

const SIGNED_OUT: Account = { signedIn: false, address: null, handle: null, signOut: () => undefined, signMessage: async () => null };
const Ctx = createContext<Account>(SIGNED_OUT);

/** An address, short enough to sit in a menu. */
export const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Reads Coinbase's hooks. Only ever mounted inside their provider. */
function Publish({ children }: { children: ReactNode }) {
  const { isSignedIn } = useIsSignedIn();
  const { evmAddress } = useEvmAddress();
  const { currentUser } = useCurrentUser();
  const { signOut } = useSignOut();
  const { signEvmMessage } = useSignEvmMessage();
  const user = currentUser as { authenticationMethods?: { email?: { email?: string }; sms?: { phoneNumber?: string } } } | null;
  const account = useMemo<Account>(() => {
    const handle = user?.authenticationMethods?.email?.email ?? user?.authenticationMethods?.sms?.phoneNumber ?? (evmAddress ? shortAddress(evmAddress) : null);
    return {
      signedIn: Boolean(isSignedIn),
      address: evmAddress ?? null,
      handle,
      signOut: () => void signOut(),
      signMessage: async (message: string) => {
        if (!evmAddress) return null;
        const { signature } = await signEvmMessage({ evmAccount: evmAddress, message });
        return signature;
      },
    };
  }, [isSignedIn, evmAddress, user, signOut, signEvmMessage]);
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
