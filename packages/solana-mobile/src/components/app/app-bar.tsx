import * as Clipboard from "expo-clipboard";
import { ActivityIcon, ArrowUpRightIcon, CheckIcon, CopyIcon, LogOutIcon, MoonIcon, SunIcon, TrophyIcon, UserIcon } from "@/components/ui/icons";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { playerName } from "@skech/core/social";
import { Button, Popover, Row, useColors, Wordmark } from "@/components/ui";
import { shortAddress } from "@/lib/market";
import { money } from "@/lib/money";
import { useSocialPick } from "@/lib/social";
import { setDark, useDark } from "@/lib/theme";
import { useAccount } from "./auth";
import { useGate } from "./gate";
import { useChain } from "./ink/chain-context";
import { AccountAvatar } from "./player-avatar";
import { useCommunity } from "./social-provider";

function CopyAddress({ address }: { address: string }) {
  const c = useColors();
  const [copied, setCopied] = useState(false);
  return (
    <Pressable
      accessibilityLabel={copied ? "Address copied" : `Copy address ${address}`}
      className="flex-row items-center gap-1 self-start"
      onPress={async () => {
        await Clipboard.setStringAsync(address);
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      }}
    >
      <Text className="text-[13px] text-muted-foreground" style={{ fontVariant: ["tabular-nums"] }}>
        {shortAddress(address)}
      </Text>
      {copied ? <CheckIcon color={c.muted} size={12} /> : <CopyIcon color={c.muted} size={12} />}
    </Pressable>
  );
}

/**
 * The bar over the game: the wordmark, light or dark, Deposit, and the account. Signed out it is only light or dark:
 * the way in is the one "Sign in to play" in the middle of the game. Signed in, the account is a small menu: who you
 * are, withdrawing, their transactions, and signing out. As on the web (app-bar.tsx), over the game,
 * under the phone's status bar.
 */
export function AppBar() {
  const me = useAccount();
  const chain = useChain();
  const gate = useGate();
  const dark = useDark();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const [menu, setMenu] = useState(false);
  const community = useCommunity();
  // The bar is the one place outside the sheet that reads the feed: who is playing, and the account's face.
  const address = me.address;
  const profile = useSocialPick((s) => (address ? s.profiles[address] : undefined));
  const playing = useSocialPick((s) => s.playing.length);
  const counted = chain.real && chain.hello?.activity === true;
  const name = profile?.username ? playerName(profile) : (me.email ?? (me.kind === "wallet" ? "Your wallet" : (me.handle ?? "Your wallet")));
  return (
    <View className="absolute inset-x-0 top-0 z-30 flex-row items-center gap-2 px-4 pb-2" style={{ paddingTop: insets.top + 8, height: insets.top + 64 }}>
      <Wordmark />
      <View className="ml-auto flex-row items-center gap-2">
        {community ? (
          <Pressable accessibilityLabel={playing ? `Leaderboard and players: ${playing} playing now` : "Leaderboard and players"} className="size-11 items-center justify-center rounded-full bg-secondary" onPress={() => community.open(playing ? "activity" : "leaderboard")}>
            <TrophyIcon color={c.fg} size={20} />
            {playing ? (
              <View className="absolute -top-0.5 -right-0.5 h-[18px] min-w-[18px] items-center justify-center rounded-full border-2 border-background bg-success px-1">
                <Text className="font-semibold text-[10px] text-white" style={{ fontVariant: ["tabular-nums"] }}>
                  {playing > 99 ? "99+" : playing}
                </Text>
              </View>
            ) : null}
          </Pressable>
        ) : null}
        {/* Signed in, light or dark is in the account's menu: the bar has the trophy, Deposit and the account. */}
        {!community || !me.signedIn ? (
          <Button accessibilityLabel={dark ? "Switch to light" : "Switch to dark"} onPress={() => setDark(!dark)} size="icon" variant="secondary">
            {dark ? <SunIcon color={c.fg} size={20} /> : <MoonIcon color={c.fg} size={20} />}
          </Button>
        ) : null}
        {/* Signed out there is nothing to deposit into. */}
        {me.signedIn ? (
          <Button onPress={() => gate.openDeposit("app_bar")} size="md" variant="secondary">
            Deposit
          </Button>
        ) : null}
        {!me.ready ? <View className="size-11 rounded-full bg-secondary" /> : null}
        {me.signedIn && me.address ? (
          <Pressable accessibilityLabel="Your account" className="size-11 items-center justify-center rounded-full bg-secondary" onPress={() => setMenu(true)}>
            <AccountAvatar address={me.address} profile={profile} size={30} />
          </Pressable>
        ) : null}
      </View>

      {me.signedIn && me.address ? (
        <Popover anchor={{ top: insets.top + 60, right: 16 }} onClose={() => setMenu(false)} open={menu} width={288}>
          <View className="flex-row items-center gap-3 px-2.5 pt-2.5 pb-3">
            <AccountAvatar address={me.address} profile={profile} size={44} />
            <View className="min-w-0 flex-1 gap-0.5">
              <Text className="font-semibold text-[15px] text-foreground" numberOfLines={1}>
                {name}
              </Text>
              <CopyAddress address={me.address} />
            </View>
          </View>
          <View className="mx-1 mb-1 h-px bg-border" />
          {community ? (
            <Row
              icon={<UserIcon color={c.fg} size={18} />}
              onPress={() => {
                setMenu(false);
                community.open("profile", me.address ?? undefined);
              }}
            >
              Your profile
            </Row>
          ) : null}
          {community ? (
          <Row
            icon={dark ? <SunIcon color={c.fg} size={18} /> : <MoonIcon color={c.fg} size={18} />}
            onPress={() => {
              setMenu(false);
              setDark(!dark);
            }}
          >
            {dark ? "Light appearance" : "Dark appearance"}
          </Row>
          ) : null}
          {chain.real ? (
            <Row
              disabled={chain.balance <= 0}
              icon={<ArrowUpRightIcon color={c.fg} size={18} />}
              onPress={() => {
                setMenu(false);
                gate.openWithdraw();
              }}
              trailing={money(chain.balance)}
            >
              Withdraw
            </Row>
          ) : null}
          {counted ? (
            <Row
              icon={<ActivityIcon color={c.fg} size={18} />}
              onPress={() => {
                setMenu(false);
                gate.openTransactions();
              }}
            >
              Transactions
            </Row>
          ) : null}
          <Row
            destructive
            icon={<LogOutIcon color={dark ? "#ff453a" : "#d70015"} size={18} />}
            onPress={() => {
              setMenu(false);
              me.signOut();
            }}
          >
            Sign out
          </Row>
        </Popover>
      ) : null}
    </View>
  );
}
