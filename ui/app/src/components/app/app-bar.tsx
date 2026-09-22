"use client";

import {
  ArrowDownToLineIcon,
  ArrowUpFromLineIcon,
  LifeBuoyIcon,
  LogOutIcon,
  SearchIcon,
  SettingsIcon,
  UserIcon,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Kbd } from "@/components/ui/kbd";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu";
import { signedUsd, usd } from "@/lib/market";
import { Wordmark } from "./logo";
import { ThemeToggle } from "./theme-toggle";
import { useSettings } from "@/lib/settings";
import { SettingsSheet } from "./settings";
import { announceSoon } from "./soon";
import { useProfile } from "@/lib/profile";
import { cn } from "@/lib/utils";
import { hasAuth, useAccount } from "./auth";
import { CopyAddress } from "./copy";
import { DepositSheet } from "./deposit";
import { PlayerOnboarding, Buddy } from "./player-onboarding";
import { usePlayer } from "@/lib/social";
import { NetworkBadge } from "./network-badge";
import { SignInButton } from "./sign-in";

export function AppBar() {
  const [{ blurred }, set] = useSettings();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const me = useAccount();
  const profile = useProfile(me.address);
  const social = usePlayer(me.address, me.signMessage);
  const [askName, setAskName] = useState(false);
  const [depositing, setDepositing] = useState(false);
  /* Signed out with auth available, the only thing in the corner is the way in. */
  const anonymous = hasAuth && !me.signedIn;
  /*
    A name, a handle, or the wallet. "Hola, 0x3e32…0136" is the app admitting
    it does not know who you are, so it asks once, the first time somebody
    signs in without a name on file.
  */
  const name = social.player?.username ?? profile.name ?? me.handle ?? "Your profile";
  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (!me.signedIn || !me.address || !social.ready || opened.current === me.address) return;
    opened.current = me.address;
    try { if (localStorage.getItem(`skech.onboarding.${me.address.toLowerCase()}`)) return; } catch {}
    // Reconcile the external wallet session and browser onboarding preference.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAskName(true);
  }, [me.signedIn, me.address, social.ready]);

  /*
    What the account is worth, from the venue rather than from a constant.
    Collateral is what can be traded with; equity adds what anything open has
    made, and that is the figure a reader means by "my balance".
  */
  const perp = profile.balance;
  const cash = perp?.equity ?? null;
  const funded = perp !== null && perp.accountIndex !== null;
  return (
    <>
    {/*
      Taller on a phone, because the things in it are now thumb-sized.

      Forty-four pixel buttons in a forty-eight pixel bar leave two pixels top
      and bottom: they read as jammed in, and next to each other they were
      forty-four and forty, so nothing lined up. Fifty-six is what a phone
      header is on both platforms, and it is unchanged on a desk.
    */}
    <header className="flex h-14 shrink-0 items-center gap-2 border-b bg-background px-3 sm:h-12 sm:gap-3">
      <Link aria-label="skech home" className="shrink-0 transition-opacity hover:opacity-70" href="/app">
        <Wordmark />
      </Link>

      {/* Inert: one market. The field says so rather than looking broken. */}
      <InputGroup className="mx-auto hidden w-full max-w-md md:flex">
        <InputGroupAddon>
          <SearchIcon />
        </InputGroupAddon>
        <InputGroupInput aria-label="Search markets" disabled placeholder="Search markets. Bitcoin only, for now" type="search" />
        <InputGroupAddon align="inline-end">
          <Kbd>/</Kbd>
        </InputGroupAddon>
      </InputGroup>

      {/* Logo and the way in. The market is on the chart itself on a phone:
          a nav bar is for the app, and a price belongs with the picture of it. */}
      <div className="ml-auto flex shrink-0 items-center gap-2 md:ml-0">
        <NetworkBadge className="max-sm:hidden" />
        {/* A reading, not a control: a Button with no onClick promised a press. */}
        {anonymous ? null : (
          <span className="hidden max-w-40 items-center gap-1 truncate px-1 font-medium text-sm lg:inline-flex">
            <span className="sr-only">Perp balance: </span>
            <span className="figures">{cash === null ? "—" : `$${usd(cash)}`}</span>
            {/* Nothing deposited yet, so the zero is a fact rather than a loss. */}
            {perp && !funded ? <span className="font-normal text-muted-foreground text-xs">to deposit</span> : null}
          </span>
        )}
        {anonymous ? null : (
          <Button
            className="hidden lg:inline-flex"
            onClick={() => (me.address ? setDepositing(true) : announceSoon("Sign in first, then you can add money."))}
            variant="secondary"
          >
            <ArrowDownToLineIcon />
            Deposit
          </Button>
        )}

        {/* Light or dark moves into the tools drawer on a phone: the bar holds
            the logo, the market and the way in, and nothing else fits. */}
        <ThemeToggle className="max-sm:hidden" />

        {anonymous ? <SignInButton /> : null}
        {anonymous ? null : (
        <Menu>
          <MenuTrigger
            render={<Button aria-label="Your account" className="rounded-full p-0" size="icon" variant="outline" />}
          >
            {/* Scales with the button it sits in, which is bigger on a
                phone. Left at seven it was a small disc adrift in a large
                circle. */}
            <Avatar className="size-8 sm:size-7">
              <Buddy color={social.player?.buddy} className="size-full"/>
              <AvatarFallback>
                <UserIcon className="size-4 sm:size-3.5" />
              </AvatarFallback>
            </Avatar>
          </MenuTrigger>
          <MenuPopup align="end" className="w-64">
            <div className="flex items-center gap-3 px-2 py-2">
              <Avatar className="size-10">
                <Buddy color={social.player?.buddy} className="size-full"/>
                <AvatarFallback>{name.slice(0, 2)}</AvatarFallback>
              </Avatar>
              {/* The address appeared twice when nobody had set a name: once
                  as the greeting and again under it. Now the greeting either
                  has a name or steps out of the way. min-w-0 and truncate on
                  both lines, because a name runs to 24 characters and an
                  address to 42. */}
              <div className="min-w-0 flex-1 leading-tight">
                <p className="truncate font-medium">{social.player ? `@${name}` : name}</p>
                {me.address ? (
                  <CopyAddress address={me.address} className="text-muted-foreground text-xs" />
                ) : (
                  <p className="figures truncate text-muted-foreground text-xs">{cash === null ? "—" : `$${usd(cash)}`}</p>
                )}
              </div>
            </div>
            {perp ? (
              <>
                <MenuSeparator />
                {/* Short enough not to grow the menu. What to do about it is
                    the next line down, so the sentence does not have to say. */}
                <p className="px-2 py-2 text-muted-foreground text-xs">
                  {funded ? (
                    <>
                      <span className="figures text-foreground">${usd(perp.equity)}</span> total equity
                      <span className="block mt-1">${usd(perp.available)} available to trade</span>
                      {perp.positions > 0 ? (
                        <>
                          <span className={cn("figures", perp.unrealised >= 0 ? "text-up" : "text-down")}>{signedUsd(perp.unrealised)}</span> open
                        </>
                      ) : null}
                    </>
                  ) : (
                    "Nothing on Lighter yet"
                  )}
                </p>
              </>
            ) : null}
            <MenuSeparator />
            <MenuGroup>
              <MenuItem onClick={() => (me.address ? setDepositing(true) : announceSoon("Sign in first, then you can add money."))}>
                <ArrowDownToLineIcon />
                Deposit
              </MenuItem>
              <MenuItem onClick={() => announceSoon("Withdrawals open when the venue is wired up.")}>
                <ArrowUpFromLineIcon />
                Withdraw
              </MenuItem>
            </MenuGroup>
            <MenuSeparator />
            <MenuCheckboxItem checked={blurred} onCheckedChange={(next) => set({ blurred: next })}>
              Privacy
            </MenuCheckboxItem>
            <MenuItem onClick={() => setAskName(true)}><UserIcon />{social.player ? "Your profile" : "Finish setup"}</MenuItem>
            <MenuItem onClick={() => setSettingsOpen(true)}>
              <SettingsIcon />
              Settings
            </MenuItem>
            <MenuItem onClick={() => announceSoon("Support is not built yet.")}>
              <LifeBuoyIcon />
              Support
            </MenuItem>
            <MenuSeparator />
            <MenuItem onClick={() => (me.signedIn ? me.signOut() : announceSoon("There is no wallet connected yet."))} variant="destructive">
              <LogOutIcon />
              {me.signedIn ? "Sign out" : "Disconnect"}
            </MenuItem>
          </MenuPopup>
        </Menu>
        )}
      </div>
    </header>
    <SettingsSheet onOpenChange={setSettingsOpen} open={settingsOpen} />
    <DepositSheet address={me.address} onDone={profile.refresh} onOpenChange={setDepositing} open={depositing} />
    <PlayerOnboarding key={`${me.address}:${askName}`} social={social} open={askName} onDeposit={() => setDepositing(true)} onOpenChange={(next) => {
      if (!next && me.address) { try { localStorage.setItem(`skech.onboarding.${me.address.toLowerCase()}`, "seen"); } catch {} }
      setAskName(next);
    }}/>

    </>
  );
}
