"use client";

import { useCurrentUser, useEvmAddress, useIsSignedIn, useSignOut } from "@coinbase/cdp-hooks";
import { CDPReactProvider, type Config } from "@coinbase/cdp-react";
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
  // Email, phone, or Google. Whatever someone already has.
  authMethods: ["email", "sms", "oauth:google"],
  ethereum: { createOnLogin: "eoa" },
};

export type Account = {
  signedIn: boolean;
  /** The wallet's address, once there is one. */
  address: string | null;
  /** Whatever they signed in with, for the greeting. */
  handle: string | null;
  signOut: () => void;
};

const SIGNED_OUT: Account = { signedIn: false, address: null, handle: null, signOut: () => undefined };
const Ctx = createContext<Account>(SIGNED_OUT);

/** An address, short enough to sit in a menu. */
export const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Reads Coinbase's hooks. Only ever mounted inside their provider. */
function Publish({ children }: { children: ReactNode }) {
  const { isSignedIn } = useIsSignedIn();
  const { evmAddress } = useEvmAddress();
  const { currentUser } = useCurrentUser();
  const { signOut } = useSignOut();
  const user = currentUser as { authenticationMethods?: { email?: { email?: string }; sms?: { phoneNumber?: string } } } | null;
  const account = useMemo<Account>(() => {
    const handle = user?.authenticationMethods?.email?.email ?? user?.authenticationMethods?.sms?.phoneNumber ?? (evmAddress ? shortAddress(evmAddress) : null);
    return { signedIn: Boolean(isSignedIn), address: evmAddress ?? null, handle, signOut: () => void signOut() };
  }, [isSignedIn, evmAddress, user, signOut]);
  return <Ctx.Provider value={account}>{children}</Ctx.Provider>;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  if (!hasAuth) return <Ctx.Provider value={SIGNED_OUT}>{children}</Ctx.Provider>;
  return (
    <CDPReactProvider config={config}>
      <Publish>{children}</Publish>
    </CDPReactProvider>
  );
}

/** Who is signed in. Answers signed out rather than throwing where there is no auth. */
export function useAccount(): Account {
  return useContext(Ctx);
}
