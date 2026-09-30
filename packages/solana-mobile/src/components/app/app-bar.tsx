import * as Clipboard from "expo-clipboard";
import { LinearGradient } from "expo-linear-gradient";
import { ActivityIcon, ArrowUpRightIcon, CheckIcon, CopyIcon, LogOutIcon, MoonIcon, SunIcon } from "lucide-react-native";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, Popover, Row, swatch, useColors, Wordmark } from "@/components/ui";
import { shortAddress } from "@/lib/market";
import { money } from "@/lib/money";
import { setDark, useDark } from "@/lib/theme";
import { useAccount } from "./auth";
import { useGate } from "./gate";
import { useChain } from "./ink/chain-context";

/** A wallet's face: two hues from its address, the same everywhere. */
export function Face({ address, size }: { address: string; size: number }) {
  const [a, b] = swatch(address);
  return <LinearGradient colors={[a, b]} end={{ x: 1, y: 1 }} start={{ x: 0, y: 0 }} style={{ width: size, height: size, borderRadius: size / 2 }} />;
}

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
 * The bar over the game: the wordmark, light or dark, Deposit, and the way in. Signed in, the way in becomes a small
 * menu: who you are, withdrawing, their transactions, and signing out. As on the web (app-bar.tsx), over the game,
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
  const counted = chain.real && chain.hello?.activity === true;
  const anonymous = me.ready && !me.signedIn;
  const name = me.email ?? (me.kind === "wallet" ? "Your wallet" : (me.handle ?? "Your wallet"));
  return (
    <View className="absolute inset-x-0 top-0 z-30 flex-row items-center gap-2 px-4 pb-2" style={{ paddingTop: insets.top + 8, height: insets.top + 64 }}>
      <Wordmark />
      <View className="ml-auto flex-row items-center gap-2">
        <Button accessibilityLabel={dark ? "Switch to light" : "Switch to dark"} onPress={() => setDark(!dark)} size="icon" variant="secondary">
          {dark ? <SunIcon color={c.fg} size={20} /> : <MoonIcon color={c.fg} size={20} />}
        </Button>
        <Button onPress={() => (me.signedIn ? gate.openDeposit() : me.ready ? gate.openSignIn("deposit") : undefined)} size="md" variant="secondary">
          Deposit
        </Button>
        {anonymous ? (
          <Button onPress={() => gate.openSignIn("app_bar")} size="md">
            Sign in
          </Button>
        ) : null}
        {!me.ready ? <View className="size-11 rounded-full bg-secondary" /> : null}
        {me.signedIn && me.address ? (
          <Pressable accessibilityLabel="Your account" className="size-11 items-center justify-center rounded-full bg-secondary" onPress={() => setMenu(true)}>
            <Face address={me.address} size={28} />
          </Pressable>
        ) : null}
      </View>

      {me.signedIn && me.address ? (
        <Popover anchor={{ top: insets.top + 60, right: 16 }} onClose={() => setMenu(false)} open={menu} width={288}>
          <View className="flex-row items-center gap-3 px-2.5 pt-2.5 pb-3">
            <Face address={me.address} size={44} />
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
