import { CDPHooksProvider, type Config, useCurrentUser, useIsInitialized, useIsSignedIn, useSignInWithEmail, useSignInWithSms, useSignOut, useSignSolanaTransaction, useSolanaAddress, useVerifyEmailOTP, useVerifySmsOTP } from "@coinbase/cdp-hooks";
import type { transact as Transact } from "@solana-mobile/mobile-wallet-adapter-protocol";
import { getAddressDecoder } from "@solana/kit";
import { Buffer } from "buffer";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { Platform } from "react-native";
import { CDP_PROJECT_ID, hasAuth } from "@/lib/config";
import { readJson, storage, writeJson } from "@/lib/storage";
import { shortAddress } from "@/lib/market";

/**
 * Signing in, two ways, one account shape.
 *
 * - Coinbase's embedded wallet: an email and a one-time code, no seed phrase, a Solana account made at sign-in and
 *   kept in Coinbase's enclave. It signs without prompting, so a deposit or a session is one tap. The web's way in.
 * - A Solana wallet on the phone, through the Mobile Wallet Adapter (Android: Phantom, Solflare, the Seeker's Seed
 *   Vault). Every signature is the wallet's own prompt.
 *
 * Either way the app reads one `Account`: who, and a way to sign a transaction the relayer built. As on the web,
 * Coinbase's hooks only work inside their provider, so they are read in one component that mounts there.
 */

export type WalletKind = "coinbase" | "wallet";
export type Account = {
  /** Whether the saved session has been read. Until then nobody is asked to sign in. */
  ready: boolean;
  signedIn: boolean;
  kind: WalletKind | null;
  /** The Solana address, base58, once there is one. */
  address: string | null;
  /** Whatever they signed in with, for the greeting. */
  handle: string | null;
  email: string | null;
  signOut: () => void;
  /** Sign a transaction (base64, the relayer's), returning it signed (base64). */
  signTransaction: (base64: string) => Promise<string>;
  /** Several at once, in order: a wallet on the phone signs them all in one visit rather than opening once each. */
  signTransactions: (base64s: string[]) => Promise<string[]>;
  /** Coinbase: send a one-time code to an email or a phone (E.164); then `verify` it. What went wrong, or null. */
  sendCode: (email: string) => Promise<string | null>;
  sendSms: (phone: string) => Promise<string | null>;
  verify: (code: string) => Promise<string | null>;
  /** A wallet on the phone, through the Mobile Wallet Adapter. Android only. */
  connectWallet: () => Promise<string | null>;
  canConnectWallet: boolean;
};

const READY_WITHIN_MS = 8000;
/** The Mobile Wallet Adapter is Android's: its native module is not in the iPhone build, and importing it there throws. */
const transact: typeof Transact = (...args) => {
  if (Platform.OS !== "android") return Promise.reject(new Error("Solana wallets on the phone connect on Android"));
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require("@solana-mobile/mobile-wallet-adapter-protocol") as { transact: typeof Transact }).transact(...args);
};
// www, not the bare domain: that redirects, and a wallet checks this site's .well-known/assetlinks.json for this app and its key.
const IDENTITY = { name: "skech", uri: "https://www.skech.trade", icon: "icon.png" };
const MWA_KEY = "skech:mwa";
type Saved = { address: string; authToken: string; cluster: string };
const b64ToBase58 = (b64: string) => getAddressDecoder().decode(Uint8Array.from(Buffer.from(b64, "base64")));
/** The cluster the relayer is on, for the wallet to sign for: devnet unless the build says mainnet. */
const CHAIN = process.env.EXPO_PUBLIC_SOLANA_CLUSTER === "mainnet-beta" ? "solana:mainnet" : "solana:devnet";

const nobody = { ready: true, signedIn: false, kind: null, address: null, handle: null, email: null } as const;
export const AccountContext = createContext<Account>({
  ...nobody,
  signOut: () => undefined,
  signTransaction: async () => {
    throw new Error("Not signed in");
  },
  signTransactions: async () => {
    throw new Error("Not signed in");
  },
  sendCode: async () => "Sign-in is not set up in this build",
  sendSms: async () => "Sign-in is not set up in this build",
  verify: async () => "Sign-in is not set up in this build",
  connectWallet: async () => "Not available",
  canConnectWallet: false,
});

/** The Mobile Wallet Adapter half: an address and an auth token, kept so the wallet does not ask again. */
function useMobileWallet() {
  const [saved, setSaved] = useState<Saved | null>(() => readJson<Saved>(MWA_KEY));
  const connect = useCallback(async (): Promise<string | null> => {
    try {
      const auth = await transact((wallet) => wallet.authorize({ identity: IDENTITY, chain: CHAIN }));
      const address = b64ToBase58(auth.accounts[0].address);
      const s = { address, authToken: auth.auth_token, cluster: CHAIN };
      writeJson(MWA_KEY, s);
      setSaved(s);
      return null;
    } catch (e) {
      return String((e as Error).message ?? e) || "The wallet said no";
    }
  }, []);
  const signAll = useCallback(
    async (base64s: string[]) => {
      if (!saved) throw new Error("No wallet connected");
      return transact(async (wallet) => {
        const auth = await wallet.reauthorize({ auth_token: saved.authToken, identity: IDENTITY }).catch(() => wallet.authorize({ identity: IDENTITY, chain: CHAIN }));
        if (auth.auth_token !== saved.authToken) {
          const s = { ...saved, authToken: auth.auth_token };
          writeJson(MWA_KEY, s);
          setSaved(s);
        }
        const { signed_payloads } = await wallet.signTransactions({ payloads: base64s });
        return signed_payloads;
      });
    },
    [saved],
  );
  const sign = useCallback(async (base64: string) => (await signAll([base64]))[0], [signAll]);
  const disconnect = useCallback(() => {
    storage.delete(MWA_KEY);
    setSaved(null);
  }, []);
  return { saved, connect, sign, signAll, disconnect };
}

/** Reads Coinbase's hooks. Only ever mounted inside their provider. */
function Publish({ children }: { children: ReactNode }) {
  const mwa = useMobileWallet();
  const { isInitialized } = useIsInitialized();
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setWaited(true), READY_WITHIN_MS);
    return () => clearTimeout(t);
  }, []);
  const { isSignedIn } = useIsSignedIn();
  const { solanaAddress } = useSolanaAddress();
  const { currentUser } = useCurrentUser();
  const { signOut } = useSignOut();
  const { signInWithEmail } = useSignInWithEmail();
  const { verifyEmailOTP } = useVerifyEmailOTP();
  const { signInWithSms } = useSignInWithSms();
  const { verifySmsOTP } = useVerifySmsOTP();
  const { signSolanaTransaction } = useSignSolanaTransaction();
  const [flow, setFlow] = useState<{ id: string; by: "email" | "sms" } | null>(null);
  const ready = Boolean(isInitialized) || waited;
  const user = currentUser as { authenticationMethods?: { email?: { email?: string }; sms?: { phoneNumber?: string }; google?: { email?: string }; apple?: { email?: string } } } | null;

  const account = useMemo<Account>(() => {
    const coinbase = Boolean(isSignedIn && solanaAddress);
    const email = user?.authenticationMethods?.email?.email ?? user?.authenticationMethods?.google?.email ?? user?.authenticationMethods?.apple?.email ?? null;
    const phone = user?.authenticationMethods?.sms?.phoneNumber ?? null;
    const address = coinbase ? solanaAddress! : (mwa.saved?.address ?? null);
    return {
      ready,
      signedIn: coinbase || Boolean(mwa.saved),
      kind: coinbase ? "coinbase" : mwa.saved ? "wallet" : null,
      address,
      handle: coinbase ? (email ?? phone ?? (address ? shortAddress(address) : null)) : address ? shortAddress(address) : null,
      email: coinbase ? email : null,
      signOut: () => {
        if (coinbase) void signOut();
        mwa.disconnect();
      },
      signTransaction: async (base64) => {
        if (coinbase) return (await signSolanaTransaction({ solanaAccount: solanaAddress!, transaction: base64 })).signedTransaction;
        return mwa.sign(base64);
      },
      signTransactions: async (base64s) => {
        if (!coinbase) return mwa.signAll(base64s);
        // Coinbase signs in the app without asking, so one at a time costs nothing.
        const out: string[] = [];
        for (const t of base64s) out.push((await signSolanaTransaction({ solanaAccount: solanaAddress!, transaction: t })).signedTransaction);
        return out;
      },
      sendCode: async (e) => {
        try {
          const r = await signInWithEmail({ email: e.trim() });
          console.info("sign-in: a code went out by email, sign-in", r.flowId);
          setFlow({ id: r.flowId, by: "email" });
          return null;
        } catch (err) {
          return String((err as Error).message ?? err);
        }
      },
      sendSms: async (phone) => {
        try {
          const r = await signInWithSms({ phoneNumber: phone });
          console.info("sign-in: a code went out by text, sign-in", r.flowId);
          setFlow({ id: r.flowId, by: "sms" });
          return null;
        } catch (err) {
          return String((err as Error).message ?? err);
        }
      },
      verify: async (code) => {
        if (!flow) return "Ask for a code first";
        try {
          if (flow.by === "sms") await verifySmsOTP({ flowId: flow.id, otp: code.trim() });
          else await verifyEmailOTP({ flowId: flow.id, otp: code.trim() });
          setFlow(null);
          return null;
        } catch (err) {
          console.warn("sign-in: the code was not accepted", err);
          // Coinbase answers a wrong code with a bare 401, and every send starts a new sign-in with its own code: say which one counts.
          if ((err as { statusCode?: number }).statusCode === 401) return `That code didn't match. Use the one in the newest ${flow.by === "sms" ? "text" : "email"}, or tap Resend code.`;
          return String((err as Error).message ?? err);
        }
      },
      connectWallet: mwa.connect,
      canConnectWallet: Platform.OS === "android",
    };
  }, [ready, isSignedIn, solanaAddress, user, mwa, signOut, signSolanaTransaction, signInWithEmail, verifyEmailOTP, signInWithSms, verifySmsOTP, flow]);
  return <AccountContext.Provider value={account}>{children}</AccountContext.Provider>;
}

/** Without a Coinbase project, the wallet on the phone is still a way in. */
function WalletOnly({ children }: { children: ReactNode }) {
  const mwa = useMobileWallet();
  const account = useMemo<Account>(
    () => ({
      ready: true,
      signedIn: Boolean(mwa.saved),
      kind: mwa.saved ? "wallet" : null,
      address: mwa.saved?.address ?? null,
      handle: mwa.saved ? shortAddress(mwa.saved.address) : null,
      email: null,
      signOut: mwa.disconnect,
      signTransaction: mwa.sign,
      signTransactions: mwa.signAll,
      sendCode: async () => "Email sign-in is not set up in this build",
      sendSms: async () => "Phone sign-in is not set up in this build",
      verify: async () => "Email sign-in is not set up in this build",
      connectWallet: mwa.connect,
      canConnectWallet: Platform.OS === "android",
    }),
    [mwa],
  );
  return <AccountContext.Provider value={account}>{children}</AccountContext.Provider>;
}

const config = { projectId: CDP_PROJECT_ID, appName: "skech", solana: { createOnLogin: true }, disableAnalytics: true } as unknown as Config;

export function AuthProvider({ children }: { children: ReactNode }) {
  if (!hasAuth) return <WalletOnly>{children}</WalletOnly>;
  return (
    <CDPHooksProvider config={config}>
      <Publish>{children}</Publish>
    </CDPHooksProvider>
  );
}

export function useAccount(): Account {
  return useContext(AccountContext);
}
