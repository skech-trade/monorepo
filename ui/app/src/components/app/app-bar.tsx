"use client";

import {
  ArrowDownToLineIcon,
  ArrowUpFromLineIcon,
  EyeOffIcon,
  GiftIcon,
  HistoryIcon,
  LifeBuoyIcon,
  LogOutIcon,
  SearchIcon,
  SettingsIcon,
  UserIcon,
} from "lucide-react";
import Link from "next/link";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Kbd } from "@/components/ui/kbd";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu";
import { type Account, usd } from "@/lib/market";
import { type Mode, MODES } from "@/lib/mode";
import { Segmented } from "./controls";
import { Wordmark } from "./logo";

export function AppBar({
  account,
  mode,
  onMode,
  blurred,
  onBlurred,
}: {
  account: Account;
  mode: Mode;
  onMode: (mode: Mode) => void;
  blurred: boolean;
  onBlurred: (blurred: boolean) => void;
}) {
  return (
    <header className="flex h-14 items-center gap-3 border-b bg-background px-4">
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
        <Button className="hidden lg:inline-flex" variant="outline">
          <span className="figures">${usd(account.balance)}</span>
          <span className="text-muted-foreground">cash</span>
        </Button>
        <Button className="hidden lg:inline-flex" variant="secondary">
          Deposit
        </Button>

        <Segmented label="Draw or Desk" onChange={onMode} options={MODES} value={mode} />

        <Menu>
          <MenuTrigger
            render={<Button aria-label="Your account" size="icon" variant="outline" />}
          >
            <Avatar className="size-6">
              <AvatarFallback>
                <UserIcon className="size-3.5" />
              </AvatarFallback>
            </Avatar>
          </MenuTrigger>
          <MenuPopup align="end" className="min-w-56">
            <MenuGroup>
              <MenuGroupLabel className="flex items-baseline justify-between">
                <span>Cash</span>
                <span className="figures text-foreground">${usd(account.balance)}</span>
              </MenuGroupLabel>
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
            <MenuItem>
              <UserIcon />
              Your profile
            </MenuItem>
            <MenuCheckboxItem checked={blurred} onCheckedChange={(next) => onBlurred(next)}>
              <EyeOffIcon />
              Blur balances
            </MenuCheckboxItem>
            <MenuItem>
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
  );
}
