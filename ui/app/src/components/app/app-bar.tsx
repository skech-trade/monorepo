"use client";

import {
  ArrowDownToLineIcon,
  ArrowUpFromLineIcon,
  GiftIcon,
  HistoryIcon,
  LifeBuoyIcon,
  LogOutIcon,
  SearchIcon,
  SettingsIcon,
  UserIcon,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
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
import { type Account, usd } from "@/lib/market";
import { Wordmark } from "./logo";
import { ThemeToggle } from "./theme-toggle";
import { useSettings } from "@/lib/settings";
import { SettingsSheet } from "./settings";
import { HANDLE } from "@/lib/user";

/** Mock, like the balance. DiceBear's "shapes" set is CC0: abstract, no face. */
const AVATAR = `https://api.dicebear.com/9.x/shapes/svg?seed=${HANDLE}&backgroundColor=0a0a0a&shape1Color=3b82f6,10b981&shape2Color=f5f5f5&shape3Color=ef4444,f59e0b`;

export function AppBar({ account }: { account: Account }) {
  const [{ blurred }, set] = useSettings();
  const [settingsOpen, setSettingsOpen] = useState(false);
  return (
    <>
    <header className="flex h-12 shrink-0 items-center gap-3 border-b bg-background px-3">
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

      <div className="ml-auto flex shrink-0 items-center gap-2 md:ml-0">
        {/* A reading, not a control: a Button with no onClick promised a press. */}
        <span className="hidden items-center px-1 font-medium text-sm lg:inline-flex">
          <span className="sr-only">Cash balance: </span>
          <span className="figures">${usd(account.balance)}</span>
        </span>
        <Button className="hidden lg:inline-flex" variant="secondary">
          <ArrowDownToLineIcon />
          Deposit
        </Button>

        <ThemeToggle />

        <Menu>
          <MenuTrigger
            render={<Button aria-label="Your account" className="rounded-full p-0" size="icon" variant="outline" />}
          >
            <Avatar className="size-7">
              <AvatarImage alt="" src={AVATAR} />
              <AvatarFallback>
                <UserIcon className="size-3.5" />
              </AvatarFallback>
            </Avatar>
          </MenuTrigger>
          <MenuPopup align="end" className="min-w-60">
            <div className="flex items-center gap-3 px-2 py-2">
              <Avatar className="size-10">
                <AvatarImage alt="" src={AVATAR} />
                <AvatarFallback>{HANDLE.slice(0, 2)}</AvatarFallback>
              </Avatar>
              <div className="min-w-0 leading-tight">
                <p className="font-medium">Hola, {HANDLE}</p>
                <p className="text-muted-foreground text-xs">
                  <span className="figures">${usd(account.balance)}</span> cash
                </p>
              </div>
            </div>
            <MenuSeparator />
            <MenuGroup>
              <MenuItem>
                <ArrowDownToLineIcon />
                Deposit
              </MenuItem>
              <MenuItem>
                <ArrowUpFromLineIcon />
                Withdraw
              </MenuItem>
              <MenuItem>
                <HistoryIcon />
                Transfers
              </MenuItem>
            </MenuGroup>
            <MenuSeparator />
            <MenuCheckboxItem checked={blurred} onCheckedChange={(next) => set({ blurred: next })}>
              Privacy
            </MenuCheckboxItem>
            <MenuItem onClick={() => setSettingsOpen(true)}>
              <SettingsIcon />
              Settings
            </MenuItem>
            <MenuItem>
              <GiftIcon />
              Rewards
            </MenuItem>
            <MenuItem>
              <LifeBuoyIcon />
              Support
            </MenuItem>
            <MenuSeparator />
            <MenuItem variant="destructive">
              <LogOutIcon />
              Disconnect
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
    </header>
    <SettingsSheet onOpenChange={setSettingsOpen} open={settingsOpen} />
    </>
  );
}
