"use client";

import { type PrivyClientConfig, PrivyProvider, type User, useLogin, useLogout, usePrivy, useSignMessage, useSignTypedData, type WalletWithMetadata } from "@privy-io/react-auth";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Chain } from "viem";
import { chain } from "@/lib/chain";
import { RPC_URL } from "@/lib/endpoints";
import { shortAddress } from "@/lib/market";
import { type Account, NOT_YET, plain } from "./auth";

/**
 * Privy, mounted beside the app once its chunk is in (auth.tsx). Everything
 * Privy-specific is here, so the first page load never carries it.
 */

export type Bridge = { appId: string; asked: number; onAccount: (account: Account) => void };

/*
  The game's chain, with the RPC the page's Content-Security-Policy allows (src/proxy.ts) rather than viem's
  default for it, so whatever Privy asks of the chain goes where everything else of ours does.
*/
const CHAIN = { ...chain, rpcUrls: { ...chain.rpcUrls, default: { http: [RPC_URL] } } } as Chain;

/** Never Privy's own confirmation: the game asks for a signature on every session and every withdrawal. */
const SILENT = { uiOptions: { showWalletUIs: false } };

const config = (dark: boolean): PrivyClientConfig => ({
  /*
    The ways in. Each one still has to be turned on in Privy's dashboard: this list only picks from what is
    on there, it cannot turn anything on.
  */
  loginMethods: ["email", "sms", "google", "apple"],
  /*
    Light or dark to match the app, for the shades Privy derives and we do not set. The rest of the panel
    reads our own colours, through the variables in globals.css, so it follows the theme switch live.
  */
  appearance: { theme: dark ? "dark" : "light", accentColor: dark ? "#6f92ff" : "#2e5bff", walletChainType: "ethereum-only" },
  embeddedWallets: { ethereum: { createOnLogin: "users-without-wallets" }, showWalletUIs: false },
  defaultChain: CHAIN,
  supportedChains: [CHAIN],
});

/** Whether the app is dark right now: the `.dark` class theme-toggle.tsx sets on the root. */
function useDark() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  useEffect(() => {
    const root = document.documentElement;
    const o = new MutationObserver(() => setDark(root.classList.contains("dark")));
    o.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => o.disconnect();
  }, []);
  return dark;
}

export function PrivyBridge({ appId, asked, onAccount }: Bridge) {
  const dark = useDark();
  const cfg = useMemo(() => config(dark), [dark]);
  return (
    <PrivyProvider appId={appId} config={cfg}>
      <Publish asked={asked} onAccount={onAccount} />
    </PrivyProvider>
  );
}

/** The embedded wallet Privy made for them; never a wallet they linked from elsewhere. */
const embedded = (user: User | null) =>
  user?.linkedAccounts.find((a): a is WalletWithMetadata => a.type === "wallet" && a.chainType === "ethereum" && Boolean(a.walletClientType?.startsWith("privy")))?.address ?? null;

/** Reads Privy's hooks. Only ever mounted inside their provider. */
function Publish({ asked, onAccount }: Omit<Bridge, "appId">) {
  const { ready, authenticated, user } = usePrivy();
  const { login } = useLogin();
  const { logout } = useLogout();
  const { signMessage } = useSignMessage();
  const { signTypedData } = useSignTypedData();
  // Privy's functions are new on most renders; the account is published only when what it says changes.
  const fns = useRef({ logout, signMessage, signTypedData });
  useEffect(() => {
    fns.current = { logout, signMessage, signTypedData };
  });

  // Answer each sign-in asked for, once Privy can open: asked before it was ready, it opens when it is.
  const answered = useRef(0);
  useEffect(() => {
    if (!ready || asked === answered.current) return;
    answered.current = asked;
    if (!authenticated) login();
  }, [asked, ready, authenticated, login]);

  const address = embedded(user);
  const email = user?.email?.address ?? user?.google?.email ?? user?.apple?.email ?? null;
  const handle = email ?? user?.phone?.number ?? (address ? shortAddress(address) : null);
  const account = useMemo<Account>(() => {
    if (!ready) return NOT_YET;
    return {
      ready,
      signedIn: authenticated,
      address,
      handle,
      email,
      signOut: () => void fns.current.logout(),
      signMessage: async (message: string) => {
        if (!address) return null;
        const { signature } = await fns.current.signMessage({ message }, { ...SILENT, address });
        return signature;
      },
      signTypedData: async (typedData) => {
        if (!address) return null;
        const types = {
          EIP712Domain: [
            { name: "name", type: "string" },
            { name: "version", type: "string" },
            { name: "chainId", type: "uint256" },
            { name: "verifyingContract", type: "address" },
          ],
          ...typedData.types,
        };
        const { signature } = await fns.current.signTypedData({ domain: typedData.domain, types, primaryType: typedData.primaryType, message: plain(typedData.message) as Record<string, unknown> }, { ...SILENT, address });
        return signature as `0x${string}`;
      },
    };
  }, [ready, authenticated, address, handle, email]);
  useEffect(() => onAccount(account), [account, onAccount]);
  return null;
}
