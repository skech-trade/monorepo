import { LockIcon, MailIcon, PhoneIcon, WalletIcon, XIcon } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Animated, KeyboardAvoidingView, Modal, Platform, Pressable, Text, TextInput, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Path } from "react-native-svg";
import { useAccount } from "@/components/app/auth";
import { useColors } from "@/components/ui";
import { cn } from "@/lib/utils";

/**
 * Signing in, as the web's panel is: Coinbase's own (their SignInModal, in our colours). The same card, the same
 * steps and the same words: email or phone, Google, Apple, a six-digit code, "Secured by coinbase". On Android a
 * Solana wallet on the phone is one more way in, through the Mobile Wallet Adapter.
 */

type Step = { kind: "email" } | { kind: "phone" } | { kind: "code"; to: string };

function GoogleMark({ color }: { color: string }) {
  return (
    <Svg height={20} viewBox="0 0 24 24" width={20}>
      <Path d="M21.35 11.1H12v2.98h5.35c-.23 1.4-1.64 4.1-5.35 4.1-3.22 0-5.85-2.67-5.85-5.96S8.78 6.26 12 6.26c1.83 0 3.06.78 3.76 1.45l2.57-2.47C16.68 3.7 14.54 2.75 12 2.75 6.95 2.75 2.86 6.9 2.86 12S6.95 21.25 12 21.25c5.28 0 8.78-3.71 8.78-8.94 0-.6-.07-1.06-.15-1.51z" fill={color} />
    </Svg>
  );
}
function AppleMark({ color }: { color: string }) {
  return (
    <Svg height={20} viewBox="0 0 24 24" width={20}>
      <Path d="M16.37 12.62c-.02-2.3 1.88-3.4 1.96-3.46-1.07-1.56-2.73-1.78-3.32-1.8-1.41-.14-2.76.83-3.48.83-.72 0-1.82-.81-3-.79-1.54.02-2.96.9-3.76 2.28-1.6 2.78-.41 6.9 1.15 9.16.76 1.1 1.67 2.34 2.86 2.3 1.15-.05 1.58-.74 2.97-.74 1.38 0 1.77.74 2.98.72 1.23-.02 2.01-1.12 2.76-2.23.87-1.28 1.23-2.52 1.25-2.58-.03-.01-2.4-.92-2.42-3.66zM14.1 5.86c.63-.77 1.06-1.83.94-2.89-.91.04-2.01.61-2.66 1.37-.58.67-1.1 1.76-.96 2.8 1.02.08 2.05-.52 2.68-1.28z" fill={color} />
    </Svg>
  );
}

/** A grey pill with a mark on its left and its words in the middle, as Coinbase's alternatives are. */
function Alt({ icon, label, onPress, disabled, busy }: { icon: React.ReactNode; label: string; onPress: () => void; disabled?: boolean; busy?: boolean }) {
  const c = useColors();
  return (
    <Pressable className={cn("h-[46px] flex-row items-center rounded-full bg-secondary px-5", disabled && !busy && "opacity-50")} disabled={disabled} onPress={onPress} style={({ pressed }) => ({ opacity: pressed ? 0.8 : 1 })}>
      <View className="w-6 items-center">{busy ? <ActivityIndicator color={c.fg} size="small" /> : icon}</View>
      <Text className="-ml-6 flex-1 text-center font-medium text-[16px] text-foreground">{label}</Text>
    </Pressable>
  );
}

function Field({ label, value, onChangeText, placeholder, error, ...rest }: React.ComponentProps<typeof TextInput> & { label: string; error?: boolean }) {
  const c = useColors();
  const [focus, setFocus] = useState(false);
  return (
    <View className="gap-2">
      <Text className="font-medium text-[15px] text-foreground">{label}</Text>
      <TextInput
        {...rest}
        className="h-[46px] rounded-[14px] bg-popover px-3.5 text-[16px] text-foreground"
        onBlur={() => setFocus(false)}
        onChangeText={onChangeText}
        onFocus={() => setFocus(true)}
        placeholder={placeholder}
        placeholderTextColor={c.muted}
        style={{ borderWidth: focus || error ? 2 : 1, borderColor: error ? "#ff3b30" : focus ? c.brand : c.border }}
        value={value}
      />
    </View>
  );
}

/** Six boxes over one hidden field, so the phone's own code autofill fills them all at once. */
function CodeBoxes({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const c = useColors();
  const input = useRef<TextInput>(null);
  return (
    <Pressable className="flex-row justify-between" onPress={() => input.current?.focus()}>
      {Array.from({ length: 6 }, (_, i) => (
        <View className="h-[54px] w-[46px] items-center justify-center rounded-[14px] bg-popover" key={i} style={{ borderWidth: i === value.length ? 2 : 1, borderColor: i === value.length ? c.brand : c.border }}>
          <Text className="font-semibold text-[22px] text-foreground">{value[i] ?? ""}</Text>
        </View>
      ))}
      <TextInput
        autoComplete="sms-otp"
        autoFocus
        caretHidden
        keyboardType="number-pad"
        maxLength={6}
        onChangeText={(t) => onChange(t.replace(/\D/g, "").slice(0, 6))}
        ref={input}
        style={{ position: "absolute", opacity: 0, width: 1, height: 1 }}
        textContentType="oneTimeCode"
        value={value}
      />
    </Pressable>
  );
}

export function SignInSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const me = useAccount();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const [step, setStep] = useState<Step>({ kind: "email" });
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Which way in it came from: an email or a number shows under its field, Google, Apple or a wallet under the buttons.
  const [errorFrom, setErrorFrom] = useState<string | null>(null);
  const [shown, setShown] = useState(open);
  const a = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (open) {
      setShown(true);
      setStep({ kind: "email" });
      setCode("");
      setError(null);
      Animated.spring(a, { toValue: 1, useNativeDriver: true, speed: 18, bounciness: 0 }).start();
    } else Animated.timing(a, { toValue: 0, duration: 200, useNativeDriver: true }).start(() => setShown(false));
  }, [open, a]);
  // Signed in, by whichever way: the panel's work is done.
  useEffect(() => {
    if (open && me.signedIn) onClose();
  }, [open, me.signedIn, onClose]);

  const run = async (what: string, job: () => Promise<string | null>) => {
    setBusy(what);
    setError(null);
    const why = await job();
    setBusy(null);
    if (why) {
      setError(why);
      setErrorFrom(what);
    }
    return why;
  };
  const e164 = () => {
    const digits = phone.replace(/\D/g, "");
    return phone.trim().startsWith("+") ? `+${digits}` : `+1${digits}`;
  };
  const fieldError = errorFrom === "email" || errorFrom === "phone";
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const phoneOk = phone.replace(/\D/g, "").length >= 10;
  const verify = async (v: string) => {
    if (v.length !== 6 || busy) return;
    const why = await run("verify", () => me.verify(v));
    if (why) setCode("");
  };

  return (
    <Modal animationType="none" onRequestClose={onClose} statusBarTranslucent transparent visible={shown}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} className="flex-1 justify-end">
        <Animated.View className="absolute inset-0 bg-black/30" style={{ opacity: a }}>
          <Pressable accessibilityLabel="Close" className="flex-1" onPress={onClose} />
        </Animated.View>
        <Animated.View
          className="mx-2.5 rounded-[20px] border-[0.5px] border-border bg-popover px-6 pt-4"
          style={{ marginBottom: Math.max(insets.bottom, 10), paddingBottom: 18, transform: [{ translateY: a.interpolate({ inputRange: [0, 1], outputRange: [height, 0] }) }] }}
        >
          <View className="items-end">
            <Pressable accessibilityLabel="Close" className="size-8 items-center justify-center" hitSlop={10} onPress={onClose}>
              <XIcon color={c.fg} size={20} strokeWidth={2} />
            </Pressable>
          </View>
          <Text className="mt-2 mb-5 text-center font-medium text-[22px] text-foreground">{step.kind === "code" ? "Enter code" : "Sign in"}</Text>

          {step.kind === "code" ? (
            <View className="gap-4">
              <Text className="text-center text-[15px] text-muted-foreground">
                We sent a 6-digit code to <Text className="font-medium text-foreground">{step.to}</Text>
              </Text>
              <CodeBoxes
                onChange={(v) => {
                  setCode(v);
                  void verify(v);
                }}
                value={code}
              />
              <Pressable className={cn("h-[46px] items-center justify-center rounded-full bg-brand", (code.length !== 6 || busy) && "opacity-40")} disabled={code.length !== 6 || !!busy} onPress={() => void verify(code)}>
                {busy === "verify" ? <ActivityIndicator color="#fff" /> : <Text className="font-medium text-[16px] text-white">Continue</Text>}
              </Pressable>
              <Pressable className="items-center py-1" onPress={() => void run("resend", () => (step.to.includes("@") ? me.sendCode(email) : me.sendSms(e164())))}>
                <Text className="text-[15px] text-brand">{busy === "resend" ? "Sending…" : "Resend code"}</Text>
              </Pressable>
              <Pressable className="items-center" onPress={() => setStep(step.to.includes("@") ? { kind: "email" } : { kind: "phone" })}>
                <Text className="text-[14px] text-muted-foreground">{step.to.includes("@") ? "Use a different email" : "Use a different number"}</Text>
              </Pressable>
            </View>
          ) : (
            <View className="gap-4">
              {step.kind === "email" ? (
                <Field
                  autoCapitalize="none"
                  autoComplete="email"
                  autoCorrect={false}
                  error={!!error && fieldError}
                  keyboardType="email-address"
                  label="Email address"
                  onChangeText={setEmail}
                  onSubmitEditing={() => emailOk && void run("email", () => me.sendCode(email)).then((why) => !why && setStep({ kind: "code", to: email.trim() }))}
                  placeholder="name@example.com"
                  returnKeyType="go"
                  textContentType="emailAddress"
                  value={email}
                />
              ) : (
                <View className="gap-2">
                  <Text className="font-medium text-[15px] text-foreground">Phone number</Text>
                  <View className="flex-row gap-2.5">
                    <View className="h-[46px] flex-row items-center gap-1.5 rounded-[14px] border border-border bg-popover px-3.5">
                      <Text className="text-[15px]">🇺🇸</Text>
                      <Text className="text-[16px] text-muted-foreground">+1</Text>
                    </View>
                    <TextInput
                      autoComplete="tel"
                      className="h-[46px] flex-1 rounded-[14px] bg-popover px-3.5 text-[16px] text-foreground"
                      keyboardType="phone-pad"
                      onChangeText={setPhone}
                      placeholder="(000) 000-0000"
                      placeholderTextColor={c.muted}
                      style={{ borderWidth: 2, borderColor: error && fieldError ? "#ff3b30" : c.brand }}
                      textContentType="telephoneNumber"
                      value={phone}
                    />
                  </View>
                </View>
              )}
              {error && fieldError ? <Text className="-mt-1 text-[14px] text-destructive-foreground">{error}</Text> : null}
              <Pressable
                className={cn("h-[46px] items-center justify-center rounded-full bg-brand", (step.kind === "email" ? !emailOk : !phoneOk) && "opacity-40")}
                disabled={(step.kind === "email" ? !emailOk : !phoneOk) || !!busy}
                onPress={() => {
                  if (step.kind === "email") void run("email", () => me.sendCode(email)).then((why) => !why && setStep({ kind: "code", to: email.trim() }));
                  else void run("phone", () => me.sendSms(e164())).then((why) => !why && setStep({ kind: "code", to: e164() }));
                }}
                style={({ pressed }) => ({ opacity: pressed ? 0.85 : undefined })}
              >
                {busy === "email" || busy === "phone" ? <ActivityIndicator color="#fff" /> : <Text className="font-medium text-[16px] text-white">Continue</Text>}
              </Pressable>

              <View className="flex-row items-center gap-3 py-1">
                <View className="h-px flex-1 bg-border" />
                <Text className="text-[14px] text-muted-foreground">OR</Text>
                <View className="h-px flex-1 bg-border" />
              </View>

              <View className="gap-2.5">
                {step.kind === "email" ? (
                  <Alt icon={<PhoneIcon color={c.fg} size={20} />} label="Continue with phone" onPress={() => (setError(null), setStep({ kind: "phone" }))} />
                ) : (
                  <Alt icon={<MailIcon color={c.fg} size={20} />} label="Continue with email" onPress={() => (setError(null), setStep({ kind: "email" }))} />
                )}
                <Alt busy={busy === "google"} disabled={!!busy} icon={<GoogleMark color={c.fg} />} label="Continue with Google" onPress={() => void run("google", () => me.oauth("google"))} />
                <Alt busy={busy === "apple"} disabled={!!busy} icon={<AppleMark color={c.fg} />} label="Continue with Apple" onPress={() => void run("apple", () => me.oauth("apple"))} />
                {me.canConnectWallet ? <Alt busy={busy === "wallet"} disabled={!!busy} icon={<WalletIcon color={c.fg} size={20} />} label="Continue with a Solana wallet" onPress={() => void run("wallet", me.connectWallet)} /> : null}
                {error && !fieldError ? <Text className="text-center text-[14px] text-destructive-foreground">{error}</Text> : null}
              </View>
            </View>
          )}

          <View className="mt-6 flex-row items-center justify-center gap-1.5">
            <LockIcon color={c.muted} size={13} strokeWidth={2.4} />
            <Text className="text-[13px] text-muted-foreground">Secured by</Text>
            <Text className="font-bold text-[15px] text-muted-foreground" style={{ letterSpacing: -0.3 }}>
              coinbase
            </Text>
          </View>
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
