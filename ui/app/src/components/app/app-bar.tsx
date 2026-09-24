"use client";

import { LogOutIcon, UserIcon } from "lucide-react";
import Link from "next/link";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Menu, MenuCheckboxItem, MenuPopup, MenuSeparator, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { useSettings } from "@/lib/settings";
import { hasAuth, useAccount } from "./auth";
import { CopyAddress } from "./copy";
import { Wordmark } from "./logo";
import { SignInButton } from "./sign-in";
import { ThemeToggle } from "./theme-toggle";

/**
 * The bar over the game: the wordmark, light or dark, the page's own button
 * (the practice deposit), and the way in. Signed in, the way in becomes a
 * small menu: who you are, privacy, and signing out.
 *
 * Taller on a phone, where the things in it are thumb-sized: fifty-six
 * pixels is what a phone header is on both platforms.
 */
export function AppBar({ lead }: { lead?: React.ReactNode } = {}) {
  const [{ blurred }, set] = useSettings();
  const me = useAccount();
  const anonymous = hasAuth && !me.signedIn;
  const name = me.handle ?? "Your account";
  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b bg-background px-3 sm:h-12 sm:gap-3">
      <Link aria-label="skech home" className="shrink-0 transition-opacity hover:opacity-70" href="/">
        <Wordmark />
      </Link>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <ThemeToggle className="max-sm:hidden" />
        {lead}
        {anonymous ? <SignInButton /> : null}
        {hasAuth && me.signedIn ? (
          <Menu>
            <MenuTrigger render={<Button aria-label="Your account" className="rounded-full p-0" size="icon" variant="outline" />}>
              <Avatar className="size-8 sm:size-7">
                <AvatarFallback>
                  <UserIcon className="size-4 sm:size-3.5" />
                </AvatarFallback>
              </Avatar>
            </MenuTrigger>
            <MenuPopup align="end" className="w-64">
              <div className="min-w-0 px-2 py-2 leading-tight">
                <p className="truncate font-medium">{name}</p>
                {me.address ? <CopyAddress address={me.address} className="text-muted-foreground text-xs" /> : null}
              </div>
              <MenuSeparator />
              <MenuCheckboxItem checked={blurred} onCheckedChange={(next) => set({ blurred: next })}>
                Privacy
              </MenuCheckboxItem>
              <MenuSeparator />
              <MenuItem onClick={() => me.signOut()} variant="destructive">
                <LogOutIcon />
                Sign out
              </MenuItem>
            </MenuPopup>
          </Menu>
        ) : null}
      </div>
    </header>
  );
}
