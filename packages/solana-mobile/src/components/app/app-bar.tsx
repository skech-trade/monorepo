import * as Clipboard from "expo-clipboard";
import { ActivityIcon, ArrowDownLeftIcon, ArrowUpRightIcon, CheckIcon, CopyIcon, LogOutIcon, MoonIcon, SunIcon, TrophyIcon, UserIcon } from "@/components/ui/icons";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { playerName } from "@skech/core/social";
import { Button, Popover, Row, useColors, Wordmark } from "@/components/ui";
import { shortAddress } from "@/lib/market";
import { money } from "@/lib/money";
import { useSocialPick } from "@/lib/social";
import { usePaperPhase } from "@/lib/paper";
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
 * The bar over the game, laid out as a phone app's: the wordmark in the middle, the trophy (the leaderboard and who
 * is playing) on the left, and the account on the right. Signed in, the account is a small menu: who you are,
 * Deposit, withdrawing, their transactions, light or dark, and signing out. Signed out the way in is "Sign in to play"
 * in the middle of the game; during a "Try it free" run that is gone, so Sign in sits on the right. Light or dark is
 * in Settings too. Over the game, under the phone's status bar.
 */
export function AppBar() {
  const me = useAccount();
  const chain = useChain();
  const gate = useGate();
  const dark = useDark();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const [menu, setMenu] = useState(false);
  const paper = usePaperPhase();
  const community = useCommunity();
  // The bar is the one place outside the sheet that reads the feed: who is playing, and the account's face.
  const address = me.address;
  const profile = useSocialPick((s) => (address ? s.profiles[address] : undefined));
  const playing = useSocialPick((s) => s.playing.length);
  const counted = chain.real && chain.hello?.activity === true;
  const name = profile?.username ? playerName(profile) : (me.email ?? (me.kind === "wallet" ? "Your wallet" : (me.handle ?? "Your wallet")));
  return (
    <View className="absolute inset-x-0 top-0 z-30 flex-row items-center px-4 pb-2" style={{ paddingTop: insets.top + 8, height: insets.top + 64 }}>
      {/* The two sides are the same width, so the wordmark sits in the true middle. */}
      <View className="w-24 flex-row items-center justify-start">
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
      </View>
      <View className="flex-1 items-center">
        <Wordmark />
      </View>
      <View className="w-24 flex-row items-center justify-end">
        {!me.ready ? <View className="size-11 rounded-full bg-secondary" /> : null}
        {me.signedIn && me.address ? (
          <Pressable accessibilityLabel="Your account" className="size-11 items-center justify-center rounded-full bg-secondary" onPress={() => setMenu(true)}>
            <AccountAvatar address={me.address} profile={profile} size={30} />
          </Pressable>
        ) : null}
        {me.ready && !me.signedIn && paper ? (
          <Button onPress={() => gate.openSignIn("paper_bar")} size="md">
            Sign in
          </Button>
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
          {chain.real ? (
            <Row
              icon={<ArrowDownLeftIcon color={c.fg} size={18} />}
              onPress={() => {
                setMenu(false);
                gate.openDeposit("account_menu");
              }}
            >
              Deposit
            </Row>
          ) : null}
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
          <Row
            icon={dark ? <SunIcon color={c.fg} size={18} /> : <MoonIcon color={c.fg} size={18} />}
            onPress={() => {
              setMenu(false);
              setDark(!dark);
            }}
          >
            {dark ? "Light appearance" : "Dark appearance"}
          </Row>
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
