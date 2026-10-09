"use client";

import { ActivityIcon, ArrowUpRightIcon, LogOutIcon, SquarePlusIcon, TrophyIcon, UserIcon } from "lucide-react";
import { useState } from "react";
import Link from "next/link";
import { playerName } from "@skech/core/social";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Menu, MenuPopup, MenuSeparator, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { hasAuth, useAccount } from "./auth";
import { useChain } from "./ink/chain-context";
import { useGate } from "./ink/gate";
import { openHomeScreen, useInstallable } from "./ink/home-screen";
import { useCommunity } from "./ink/social-provider";
import { TransactionsSheet } from "./ink/transactions-sheet";
import { PRIVATE_TEXT } from "@/lib/analytics";
import { shortAddress } from "@/lib/market";
import { money } from "@/lib/money";
import { avatarUrl, useSocial } from "@/lib/social";
import { cn } from "@/lib/utils";
import { CopyAddress } from "./copy";
import { Wordmark } from "./logo";
import { ThemeToggle } from "./theme-toggle";

/**
 * The bar over the game: the wordmark, light or dark, the page's own button
 * (Deposit), and the account. Signed out it is only light or dark: the way in
 * is the one "Sign in to play" in the middle of the game. Signed in, the
 * account is a small menu: who you are, withdrawing, their transactions, and
 * signing out.
 *
 * Taller on a phone, where the things in it are thumb-sized: fifty-six
 * pixels is what a phone header is on both platforms.
 *
 * Under the game, a trophy opens the community (the leaderboard, the live
 * feed, profiles); on a phone it takes light or dark's place, which moves into
 * that sheet. A profile's name and picture are the account's face once set.
 */
export function AppBar({ lead, showTheme = true }: { lead?: React.ReactNode; showTheme?: boolean } = {}) {
  const me = useAccount();
  const community = useCommunity();
  const social = useSocial();
  const profile = me.address ? social.profiles[me.address] : undefined;
  const chain = useChain();
  const gate = useGate();
  // On a phone's browser, not once installed: the way to the Home Screen steps, whether or not the bar is up.
  const installable = useInstallable();
  const [txsOpen, setTxsOpen] = useState(false);
  // The transaction count, only from a relayer that keeps one.
  const counted = chain.real && chain.hello?.activity === true;
  // An email or a phone number names the account; without one it is simply the wallet, and the address says which.
  const name = profile?.username ? playerName(profile) : me.handle && me.handle !== (me.address && shortAddress(me.address)) ? me.handle : "Your wallet";
  const picture = profile ? avatarUrl(profile) : undefined;
  return (
    <header className="flex h-16 shrink-0 items-center gap-2 border-b bg-background px-4 pt-3 pb-2 sm:gap-3">
      <Link aria-label="skech home" className="shrink-0 transition-opacity hover:opacity-70" href="/">
        <Wordmark />
      </Link>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        {community ? (
          <Button aria-label="Leaderboard and players" className="size-11 rounded-full border-0 bg-secondary p-0 sm:size-11 [&_svg]:size-5" onClick={() => community.open()} size="icon" variant="secondary">
            <TrophyIcon />
          </Button>
        ) : null}
        {showTheme ? <ThemeToggle className={cn("size-11 rounded-full border-0 bg-secondary sm:size-11 [&_svg]:size-5", community && "max-sm:hidden")} /> : null}
        {lead}
        {hasAuth && !me.ready ? <span aria-hidden="true" className="size-11 shrink-0 animate-pulse rounded-full bg-secondary" /> : null}
        {hasAuth && me.signedIn ? (
          <Menu>
            <MenuTrigger render={<Button aria-label="Your account" className="size-11 rounded-full border-0 bg-secondary p-0 sm:size-11" size="icon" variant="outline" />}>
              {picture ? (
                <Avatar className="size-7">
                  <AvatarImage alt="" src={picture} />
                </Avatar>
              ) : me.address ? (
                <span aria-hidden="true" className="size-7 rounded-full ring-1 ring-foreground/10" style={{ background: swatch(me.address) }} />
              ) : (
                <Avatar className="size-9 bg-transparent">
                  <AvatarFallback>
                    <UserIcon className="size-4 sm:size-3.5" />
                  </AvatarFallback>
                </Avatar>
              )}
            </MenuTrigger>
            <MenuPopup align="end" className="w-[288px] p-1.5">
              <div className="flex items-center gap-3 px-2.5 pt-2.5 pb-3">
                <span aria-hidden="true" className="size-11 shrink-0 rounded-full ring-1 ring-foreground/10" style={{ background: me.address ? swatch(me.address) : undefined }} />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <p className={cn("truncate font-semibold text-[15px] leading-tight", PRIVATE_TEXT)}>{name}</p>
                  {me.address ? <CopyAddress address={me.address} className="self-start text-[13px] text-muted-foreground" /> : null}
                </div>
              </div>
              <MenuSeparator className="mx-1" />
              {community && me.address ? (
                <MenuItem className="min-h-11 gap-3 rounded-xl px-2.5 sm:min-h-10" onClick={() => community.open("profile", me.address ?? undefined)}>
                  <UserIcon />
                  Your profile
                </MenuItem>
              ) : null}
              {/* Money out lives with the account: the balance it comes from, and the way to send it. */}
              {chain.real ? (
                <MenuItem className="min-h-11 gap-3 rounded-xl px-2.5 sm:min-h-10" disabled={chain.balance <= 0} onClick={gate.openWithdraw}>
                  <ArrowUpRightIcon />
                  <span className="flex-1">Withdraw</span>
                  <span className="figures text-muted-foreground">{money(chain.balance)}</span>
                </MenuItem>
              ) : null}
              {/* How much of their play went on chain: the count, and the transactions to look up. Only where the
                  relayer counts it: an empty sheet of dashes says nothing. */}
              {counted ? (
                <MenuItem className="min-h-11 gap-3 rounded-xl px-2.5 sm:min-h-10" onClick={() => setTxsOpen(true)}>
                  <ActivityIcon />
                  Transactions
                </MenuItem>
              ) : null}
              {installable ? (
                <MenuItem className="min-h-11 gap-3 rounded-xl px-2.5 sm:min-h-10" onClick={openHomeScreen}>
                  <SquarePlusIcon />
                  Add to Home Screen
                </MenuItem>
              ) : null}
              <MenuItem className="min-h-11 gap-3 rounded-xl px-2.5 sm:min-h-10" onClick={() => me.signOut()} variant="destructive">
                <LogOutIcon />
                Sign out
              </MenuItem>
            </MenuPopup>
          </Menu>
        ) : null}
        {hasAuth && me.signedIn && counted ? <TransactionsSheet onOpenChange={setTxsOpen} open={txsOpen} /> : null}
      </div>
    </header>
  );
}

/** Two hues from the address, so each wallet has a face of its own that stays the same everywhere, as on the phone. */
function swatch(address: string) {
  let n = 0;
  for (let i = 0; i < 8 && i < address.length; i++) n = (n * 31 + address.charCodeAt(i)) >>> 0;
  const a = n % 360;
  const b = (a + 40 + ((n >> 9) % 80)) % 360;
  return `linear-gradient(135deg, oklch(0.72 0.14 ${a}), oklch(0.55 0.16 ${b}))`;
}
