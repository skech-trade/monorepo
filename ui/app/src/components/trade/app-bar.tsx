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
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu";
import { cn } from "@/lib/utils";
import Link from "next/link";
import { Wordmark } from "@/components/site/logo";
import { Segmented, Switch } from "./controls";
import { type Account, usd } from "./market";
import { type Mode, MODES } from "./mode";

/**
 * The bar across the top of every screen.
 *
 * One material for the whole row: every control here is 44px tall, fully
 * rounded where it can be, with a hairline edge and a white fill on the page
 * ground. They were a mix — a bare wordmark, two recessed wells and one
 * outlined circle — and a row of five things in three materials reads as three
 * unrelated rows that happen to share a line.
 *
 * It was a wordmark and a mode toggle with two thousand pixels of nothing
 * between them. What belongs in that gap is the two things a reader reaches
 * for from anywhere — find something else to trade, and see what they have to
 * trade with — so: search in the middle, money and identity on the right.
 *
 * Search is inert. It is drawn at full strength rather than greyed out because
 * there is exactly one market today and the field is a promise about the shape
 * of the product, not a control that is broken; `disabled` and the caption in
 * the placeholder say so without making the bar look unfinished.
 */

/**
 * The `/` hint and the paste affordance, after the shape fomo uses.
 *
 * Bordered and raised like everything else in this bar. The row is a set of
 * objects sitting on the page ground, and a recessed `well` fill next to four
 * outlined controls reads as a hole among them.
 */
function SearchField({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "flex h-11 min-w-0 items-center gap-2.5 rounded-full border border-input bg-popover px-4 shadow-xs/5",
        className,
      )}
    >
      <SearchIcon className="size-4 shrink-0 text-fg-subtle" />
      <input
        aria-label="Search markets"
        className="min-w-0 flex-1 bg-transparent text-caption outline-none placeholder:text-fg-subtle disabled:cursor-not-allowed"
        disabled
        placeholder="Search markets — Bitcoin only, for now"
        type="search"
      />
      <span className="hidden shrink-0 items-center gap-1.5 sm:flex">
        <Kbd className="bg-surface-3 text-fg-subtle">/</Kbd>
      </span>
    </div>
  );
}

/**
 * Cash on hand, and the one action attached to it.
 *
 * The whole chip is the button. It was a box with a small link inside it, which
 * is two hit targets stacked in a 40px space — you aim at the word "Deposit"
 * and miss, or you press the box and nothing happens. One target, the size of
 * the thing you can see.
 *
 * The amount belongs *to* the action, which is why they share a surface rather
 * than sitting near each other in the bar's whitespace. Same well fill and
 * radius as the search field beside it, so the bar is made of one kind of
 * object.
 */
function Cash({ account }: { account: Account }) {
  return (
    <Button
      // Fully rounded like the rest of the row, and with the horizontal room a
      // 22px corner radius needs — at `px-4` the second line ran into the curve.
      // `sm:h-11` is not redundant. `Button`'s default size is `h-9 sm:h-8`, and
      // a bare `h-11` only replaces the first of those — above 640px the
      // untouched `sm:h-8` wins and the chip collapses to 32px while the rest of
      // the row stays 44. Every control here that overrides a Button height has
      // to override both.
      className="hidden h-11 flex-col items-start justify-center gap-px rounded-full px-5 sm:h-11 md:flex"
      variant="outline"
    >
      {/*
        Explicit leading on both lines. The type scale gives caption a 1.6 line
        height, which is right for prose and wrong for two stacked lines in a
        44px control: 39px of text boxes in a 44px box left two pixels above and
        below, and the whole chip read as cramped against its own border.
      */}
      <span className="figures whitespace-nowrap font-normal text-caption leading-[1.15]">
        ${usd(account.balance)}
        <span className="text-fg-subtle"> cash</span>
      </span>
      <span className="text-brand text-kicker leading-[1.15]">Deposit more</span>
    </Button>
  );
}

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
  /** Hides every figure on the screen. A real feature on a shared screen. */
  blurred: boolean;
  onBlurred: (blurred: boolean) => void;
}) {
  return (
    <header className="flex flex-wrap items-center gap-x-4 gap-y-3 px-1 pt-1">
      {/*
        No surface. The other five controls are things you press and wear an
        edge to say so; the mark is the product's name, and putting it in the
        same pill made the row read as six buttons, one of which did nothing you
        would want. It is still a link — the logo goes home, which is what every
        reader will try — just not a button-shaped one.
      */}
      <Link
        aria-label="skech home"
        className="pressable flex h-11 shrink-0 items-center transition-opacity duration-micro ease-smooth-out hover:opacity-70"
        href="/app"
      >
        <Wordmark />
      </Link>

      {/* Takes the middle on a wide screen and its own full-width line below
          `md`, where a search field sharing a row with five other controls is
          80px wide and useless. */}
      {/* Draw on a phone is one screen with no scroll, and a field that
          searches a list of one is not worth the 44px it costs there. */}
      <SearchField
        className={cn(
          "order-3 w-full md:order-none md:mx-auto md:w-auto md:max-w-lg md:flex-1 xl:max-w-2xl",
          mode === "draw" && "hidden md:flex",
        )}
      />

      <div className="ml-auto flex shrink-0 items-center gap-2 md:ml-0">
        <Cash account={account} />

        <Segmented
          // The track keeps its recessed fill — a white track under a white
          // thumb is a thumb you cannot find — but takes the same hairline as
          // everything else in the row so the edges line up.
          className="h-11 border border-input shadow-xs/5"
          label="How much of the screen you want"
          onChange={onMode}
          options={MODES}
          value={mode}
        />

        <Menu>
          <MenuTrigger
            render={
              // A 16px glyph in a 36px circle read as an empty button. The
              // icon is the only thing in it, so it gets the room.
              <Button
                aria-label="Your account"
                className="size-11 rounded-full sm:size-11 [&_svg]:size-5"
                variant="outline"
              />
            }
          >
            <UserIcon />
          </MenuTrigger>
          <MenuContent>
            {/* The balance repeats here on purpose: below `md` the chip in the
                bar is hidden, and this is then the only place it appears. */}
            <div className="flex items-baseline justify-between gap-4 px-3 pt-2 pb-3">
              <span className="text-kicker text-fg-subtle">Cash</span>
              <span className="figures text-caption">
                ${usd(account.balance)}
              </span>
            </div>
            <MenuItem icon={<ArrowDownToLineIcon />}>Deposit</MenuItem>
            <MenuItem icon={<ArrowUpFromLineIcon />}>Withdraw</MenuItem>
            <MenuItem icon={<HistoryIcon />}>Transfers</MenuItem>
            <MenuSeparator />
            <MenuItem icon={<UserIcon />}>Your profile</MenuItem>
            <MenuItem
              aside={
                <Switch
                  checked={blurred}
                  label="Blur balances"
                  onChange={onBlurred}
                />
              }
              icon={<EyeOffIcon />}
            >
              Blur balances
            </MenuItem>
            <MenuItem icon={<SettingsIcon />}>Settings</MenuItem>
            <MenuItem icon={<GiftIcon />}>Rewards</MenuItem>
            <MenuItem icon={<LifeBuoyIcon />}>Support</MenuItem>
            <MenuSeparator />
            <MenuItem icon={<LogOutIcon />} tone="down">
              Disconnect
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>
    </header>
  );
}
