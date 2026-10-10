import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { avatarChoices, BIO_MAX, type LeaderboardRow, type PlayerProfile, playerName, type ProfileResponse, type SocialWindow, usernameProblem } from "@skech/core/social";
import { useAccount } from "@/components/app/auth";
import { useGate } from "@/components/app/gate";
import { Dylan, PlayerAvatar } from "@/components/app/player-avatar";
import { useCommunity } from "@/components/app/social-provider";
import { Button, Sheet, Spinner, useColors } from "@/components/ui";
import { RadioIcon, ShuffleIcon, TrophyIcon, UserIcon } from "@/components/ui/icons";
import { bindPen, cacheProfile, penBound, socialAction, socialMoney, socialRequest, useSocial } from "@/lib/social";
import { cn } from "@/lib/utils";

/**
 * The community, on the phone: the web's social sheet (ui/app/src/components/app/ink/social-sheet.tsx), the same
 * service and the same numbers. The leaderboard by window, who is playing now and the live feed, and a player's
 * page with Follow, or, for one's own, a name, a bio and a Dylan avatar.
 */
export type SocialTab = "leaderboard" | "activity" | "profile";
const windows: { value: SocialWindow; label: string }[] = [
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "all", label: "All time" },
];
const figures = { fontVariant: ["tabular-nums" as const] };
const positive = (v: string) => BigInt(v) > 0n;

function Chips<T extends string>({ items, value, onChange }: { items: { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <View className="flex-row gap-1.5">
      {items.map((item) => (
        <Pressable accessibilityState={{ selected: value === item.value }} className={cn("min-h-10 flex-1 items-center justify-center rounded-full", value === item.value ? "bg-secondary" : "")} key={item.value} onPress={() => onChange(item.value)}>
          <Text className={cn("font-medium text-[13px]", value === item.value ? "text-foreground" : "text-muted-foreground")}>{item.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

export function SocialSheet({ initialTab, initialPlayer, onClose }: { initialTab: SocialTab; initialPlayer?: string; onClose: () => void }) {
  const me = useAccount();
  const c = useColors();
  const viewer = me.address ?? "";
  const [tab, setTab] = useState<SocialTab>(initialTab);
  const [player, setPlayer] = useState<string | null>(initialPlayer ?? me.address ?? null);
  const [window, setWindow] = useState<SocialWindow>("all");
  const viewPlayer = (target: string) => {
    setPlayer(target);
    setTab("profile");
  };
  const tabs = [
    { value: "leaderboard" as const, label: "Leaderboard", Icon: TrophyIcon },
    { value: "activity" as const, label: "Live", Icon: RadioIcon },
    { value: "profile" as const, label: "Profile", Icon: UserIcon },
  ];
  return (
    <Sheet description="Who is drawing, and how it went." onClose={onClose} open title={tab === "profile" ? (player === viewer ? "Your profile" : "Player") : "Draw together"}>
      <View className="flex-row rounded-full bg-muted p-1">
        {tabs.map(({ value, label, Icon }) => (
          <Pressable
            accessibilityState={{ selected: tab === value }}
            className={cn("min-h-10 flex-1 flex-row items-center justify-center gap-1.5 rounded-full", tab === value ? "bg-background" : "")}
            key={value}
            onPress={() => {
              setTab(value);
              if (value === "profile") setPlayer(viewer || null);
            }}
          >
            <Icon color={tab === value ? c.fg : c.muted} size={14} />
            <Text className={cn("font-semibold text-[13px]", tab === value ? "text-foreground" : "text-muted-foreground")}>{label}</Text>
          </Pressable>
        ))}
      </View>
      {tab !== "activity" ? <Chips items={windows} onChange={setWindow} value={window} /> : null}
      {tab === "leaderboard" ? <Board onPlayer={viewPlayer} viewer={viewer} window={window} /> : tab === "activity" ? <Live onPlayer={viewPlayer} /> : player ? <Profile key={`${player}:${window}`} player={player} window={window} /> : <SignInFirst />}
    </Sheet>
  );
}

function SignInFirst() {
  const gate = useGate();
  return (
    <View className="items-start gap-3 rounded-[18px] bg-muted p-4">
      <Text className="text-[15px] text-muted-foreground">Sign in to make your profile and keep your drawing history.</Text>
      <Button onPress={() => gate.openSignIn("community")} size="md">
        Sign in
      </Button>
    </View>
  );
}

function Board({ window, viewer, onPlayer }: { window: SocialWindow; viewer: string; onPlayer: (p: string) => void }) {
  const social = useSocial();
  const [friends, setFriends] = useState(false);
  const [board, setBoard] = useState<{ rows: LeaderboardRow[]; me: LeaderboardRow | null; counting: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const load = () =>
      socialRequest<NonNullable<typeof board>>(`/leaderboard?window=${window}${viewer ? `&viewer=${viewer}` : ""}&friends=${friends ? "1" : "0"}`, undefined, controller.signal).then(
        (r) => {
          setBoard(r);
          setError(null);
        },
        () => !controller.signal.aborted && setError("The leaderboard is unavailable right now. Try again shortly."),
      );
    void load();
    const t = setInterval(load, 10_000);
    return () => {
      controller.abort();
      clearInterval(t);
    };
  }, [window, viewer, friends]);
  return (
    <>
      <View className="flex-row items-center justify-between px-1">
        <Text className="text-[13px] text-muted-foreground">Ranked by net PnL</Text>
        {viewer ? (
          <Pressable className="min-h-10 justify-center" onPress={() => setFriends((v) => !v)}>
            <Text className="font-medium text-[13px] text-foreground">{friends ? "Following" : "Everyone"}</Text>
          </Pressable>
        ) : null}
      </View>
      {board?.counting || social.counting ? <Text className="text-[13px] text-muted-foreground">Reading earlier drawings from the chain… the board fills in as they arrive.</Text> : null}
      {error ? (
        <Notice text={error} />
      ) : !board ? (
        <Spinner />
      ) : !board.rows.length ? (
        <Notice text={friends ? "Follow a player to see them here." : "The first drawings will start the board."} />
      ) : (
        <View className="overflow-hidden rounded-[18px] bg-muted">
          {board.rows.map((row) => (
            <LeaderRow key={row.profile.player} me={row.profile.player === viewer} onPress={() => onPlayer(row.profile.player)} row={row} />
          ))}
        </View>
      )}
      {board?.me && !board.rows.some((r) => r.profile.player === viewer) ? (
        <View className="overflow-hidden rounded-[18px] bg-muted">
          <LeaderRow me onPress={() => onPlayer(viewer)} row={board.me} />
        </View>
      ) : null}
    </>
  );
}

function LeaderRow({ row, me, onPress }: { row: LeaderboardRow; me: boolean; onPress: () => void }) {
  return (
    <Pressable className={cn("flex-row items-center gap-3 px-3.5 py-3", me && "bg-brand/5")} onPress={onPress}>
      <Text className="w-5 text-center text-[13px] text-muted-foreground" style={figures}>
        {row.rank}
      </Text>
      <PlayerAvatar profile={row.profile} size={36} />
      <View className="min-w-0 flex-1">
        <Text className="font-medium text-[15px] text-foreground" numberOfLines={1}>
          {playerName(row.profile)}
          {me ? <Text className="text-[12px] text-muted-foreground"> you</Text> : null}
        </Text>
        <Text className="text-[12px] text-muted-foreground">{row.stats.completed} finished drawings</Text>
      </View>
      <Text className={cn("font-semibold text-[15px]", positive(row.stats.pnl) ? "text-success-foreground" : "text-foreground")} style={figures}>
        {socialMoney(row.stats.pnl, true)}
      </Text>
    </Pressable>
  );
}

/** Who is playing now, and the feed. */
function Live({ onPlayer }: { onPlayer: (p: string) => void }) {
  const social = useSocial();
  const community = useCommunity();
  return (
    <>
      <View className="gap-2.5 rounded-[18px] bg-muted p-3">
        <View className="flex-row items-center gap-2">
          <View className={cn("size-2 rounded-full", social.connected ? "bg-success" : "bg-muted-foreground")} />
          <Text className="text-[13px] text-foreground">{social.connected ? (social.playing.length ? `${social.playing.length} playing now` : "Nobody is playing right now") : "Reconnecting…"}</Text>
        </View>
        {social.playing.length ? (
          <View className="flex-row flex-wrap gap-2.5">
            {social.playing.map((p) => (
              <Pressable accessibilityLabel={`Open ${playerName(p)}'s profile`} className="items-center gap-1" key={p.player} onPress={() => onPlayer(p.player)}>
                <PlayerAvatar profile={p} size={40} />
                <Text className="max-w-12 text-[10px] text-muted-foreground" numberOfLines={1}>
                  {playerName(p)}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}
      </View>
      <ShowMyPen />
      {community ? (
        <View className="gap-2 rounded-[18px] bg-muted p-3">
          <Text className="text-[12px] text-muted-foreground">Ink on your chart</Text>
          <Chips
            items={[
              { value: "everyone", label: "Everyone" },
              { value: "following", label: "Following" },
              { value: "me", label: "Only me" },
            ]}
            onChange={community.changeAudience}
            value={community.audience}
          />
        </View>
      ) : null}
      {social.activity.length ? (
        <View className="overflow-hidden rounded-[18px] bg-muted">
          {social.activity.map((item) => (
            <Pressable className="flex-row items-center gap-3 px-3.5 py-3" key={item.id} onPress={() => onPlayer(item.player)}>
              <PlayerAvatar profile={item.profile} size={36} />
              <View className="min-w-0 flex-1">
                <Text className="font-medium text-[15px] text-foreground" numberOfLines={1}>
                  {playerName(item.profile)}
                </Text>
                <Text className="text-[12px] text-muted-foreground">
                  {item.kind === "placed" ? "Drew" : item.complete ? "Drawing finished" : "Ink settled"} · {new Date(item.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                </Text>
              </View>
              <Text className={cn("font-semibold text-[15px]", item.kind === "settled" && positive(item.amount) ? "text-success-foreground" : "text-foreground")} style={figures}>
                {socialMoney(item.amount, item.kind === "settled")}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : (
        <Notice text="New drawings and results will appear here." />
      )}
    </>
  );
}

/** A wallet on the phone asks before it signs: its player says when others may see their pen as it draws. */
function ShowMyPen() {
  const me = useAccount();
  const [asked, setAsked] = useState(false);
  if (me.kind !== "wallet" || !me.address || penBound()) return null;
  return (
    <View className="gap-2 rounded-[18px] bg-muted p-3">
      <Text className="text-[13px] text-muted-foreground">Let others watch your line as you draw it. Your wallet signs once a day for it.</Text>
      <Button
        disabled={asked}
        onPress={() => {
          setAsked(true);
          bindPen(me.address, me.signMessage);
        }}
        size="md"
        variant="secondary"
      >
        {asked ? "Asked your wallet" : "Show my pen live"}
      </Button>
    </View>
  );
}

function Profile({ player, window }: { player: string; window: SocialWindow }) {
  const me = useAccount();
  const gate = useGate();
  const community = useCommunity();
  const viewer = me.address ?? "";
  const own = viewer === player;
  const [data, setData] = useState<ProfileResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    const controller = new AbortController();
    mounted.current = true;
    void socialRequest<ProfileResponse>(`/profile?player=${player}${viewer ? `&viewer=${viewer}` : ""}&window=${window}`, undefined, controller.signal).then(
      (r) => !controller.signal.aborted && setData(r),
      () => !controller.signal.aborted && setError("This profile is unavailable right now. Try again shortly."),
    );
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, [player, viewer, window]);
  const follow = async () => {
    if (!viewer) return gate.openSignIn("community");
    if (!data || busy) return;
    setBusy(true);
    setError(null);
    try {
      await socialAction(viewer, "follow", { target: player, enabled: !data.following }, me.signMessage);
      if (mounted.current) setData({ ...data, following: !data.following, profile: { ...data.profile, followers: data.profile.followers + (data.following ? -1 : 1) } });
      community?.refreshFollowing();
    } catch (e) {
      if (mounted.current) setError(String((e as Error).message ?? e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  if (!data) return error ? <Notice text={error} /> : <Spinner />;
  if (editing)
    return (
      <EditProfile
        onCancel={() => setEditing(false)}
        onSaved={(profile) => {
          // Everywhere at once: the bar's face, the feed, the board.
          cacheProfile(profile);
          setData({ ...data, profile });
          setEditing(false);
        }}
        profile={data.profile}
      />
    );
  const s = data.stats;
  return (
    <>
      <View className="flex-row items-center gap-3">
        <PlayerAvatar profile={data.profile} size={56} />
        <View className="min-w-0 flex-1">
          <Text className="font-semibold text-[18px] text-foreground" numberOfLines={1}>
            {playerName(data.profile)}
          </Text>
          <Text className="text-[12px] text-muted-foreground">
            {data.profile.followers} followers · {data.profile.following} following
          </Text>
        </View>
        {own ? (
          <Button onPress={() => setEditing(true)} size="md" variant="secondary">
            Edit
          </Button>
        ) : (
          <Button disabled={busy} onPress={() => void follow()} size="md" variant={data.following ? "secondary" : "primary"}>
            {data.following ? "Following" : "Follow"}
          </Button>
        )}
      </View>
      {data.profile.bio ? <Text className="text-[15px] text-muted-foreground leading-[21px]">{data.profile.bio}</Text> : null}
      {error ? <Notice text={error} /> : null}
      <View className="gap-1 rounded-[18px] bg-muted px-4 py-4">
        <Text className="text-[13px] text-muted-foreground">Net PnL</Text>
        <Text className={cn("font-bold text-[36px]", positive(s.pnl) ? "text-success-foreground" : "text-foreground")} style={figures}>
          {socialMoney(s.pnl, true)}
        </Text>
      </View>
      <View className="flex-row flex-wrap gap-2">
        <Stat label="Total staked" value={socialMoney(s.staked)} />
        <Stat label="Win rate" value={s.completed ? `${Math.round((s.wins / s.completed) * 100)}%` : "–"} />
        <Stat label="Finished drawings" value={String(s.completed)} />
        <Stat label="Biggest profit" value={socialMoney(s.biggest, true)} />
      </View>
      <Text className="px-1 text-[13px] text-muted-foreground">Drawings</Text>
      {data.drawings.length ? (
        <View className="overflow-hidden rounded-[18px] bg-muted">
          {data.drawings.map((d) => (
            <View className="flex-row items-center gap-3 px-3.5 py-3" key={d.id}>
              <View className="flex-1">
                <Text className="font-medium text-[15px] text-foreground">{d.complete ? (positive(d.pnl) ? "Won" : "Finished") : "In play"}</Text>
                <Text className="text-[12px] text-muted-foreground">
                  {new Date(d.at).toLocaleDateString([], { month: "short", day: "numeric" })} · {socialMoney(d.stake)} staked
                </Text>
              </View>
              <Text className={cn("font-semibold text-[15px]", positive(d.pnl) ? "text-success-foreground" : "text-foreground")} style={figures}>
                {d.complete ? socialMoney(d.pnl, true) : "Pending"}
              </Text>
            </View>
          ))}
        </View>
      ) : (
        <Notice text={own ? "Your first drawing will start the story." : "No drawings in this period."} />
      )}
    </>
  );
}

/** A name, a bio, and a Dylan avatar from a grid of them (shuffle for more): signed by the wallet, no prompt with Privy. */
function EditProfile({ profile, onCancel, onSaved }: { profile: PlayerProfile; onCancel: () => void; onSaved: (p: PlayerProfile) => void }) {
  const me = useAccount();
  const c = useColors();
  const [username, setUsername] = useState(profile.username ?? "");
  const [bio, setBio] = useState(profile.bio);
  const [seed, setSeed] = useState<string | null>(profile.avatarSeed);
  const [page, setPage] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const choices = useMemo(() => avatarChoices(profile.player, page * 8 + 1), [profile.player, page]);
  const save = async () => {
    if (!me.address || busy) return;
    const problem = usernameProblem(username);
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    try {
      // A chosen Dylan avatar is the face from now on: an uploaded picture (from the web) is let go.
      const result = await socialAction<{ profile: PlayerProfile }>(me.address, "profile", { username, bio, avatarSeed: seed, ...(profile.avatar ? { image: null } : {}) }, me.signMessage);
      onSaved(result.profile);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };
  const field = { color: c.fg, fontSize: 16, paddingHorizontal: 16, borderRadius: 18 };
  return (
    <>
      <Pressable className="min-h-10 justify-center self-start" onPress={onCancel}>
        <Text className="font-medium text-[15px] text-foreground">← Back to profile</Text>
      </Pressable>
      <View className="flex-row flex-wrap justify-between gap-y-2">
        {choices.map((choice) => {
          const value = choice === profile.player ? null : choice;
          const on = value === seed;
          return (
            <Pressable accessibilityLabel={value ? `Avatar ${choice.split(":")[1]}` : "Your address's avatar"} accessibilityState={{ selected: on }} className={cn("items-center justify-center rounded-[18px] bg-muted p-2", on && "border-2 border-brand")} key={choice} onPress={() => setSeed(value)} style={{ width: "31.5%", aspectRatio: 1 }}>
              <Dylan seed={choice} size={72} />
            </Pressable>
          );
        })}
      </View>
      <View className="flex-row items-center justify-between gap-3">
        <Button onPress={() => setPage(1 + Math.floor(Math.random() * 100_000))} size="md" variant="secondary">
          <View className="flex-row items-center gap-1.5">
            <ShuffleIcon color={c.fg} size={16} />
            <Text className="font-semibold text-[15px] text-foreground">Shuffle</Text>
          </View>
        </Button>
      </View>
      <View className="gap-2">
        <Text className="text-[13px] text-foreground">Username</Text>
        <TextInput
          autoCapitalize="none"
          autoComplete="username"
          autoCorrect={false}
          className="h-12 bg-muted"
          maxLength={24}
          onChangeText={(t) => setUsername(t.toLowerCase())}
          placeholder="your_name"
          placeholderTextColor={c.faint}
          selectionColor={c.brand}
          style={field}
          value={username}
        />
      </View>
      <View className="gap-2">
        <Text className="text-[13px] text-foreground">Bio</Text>
        <TextInput className="min-h-24 bg-muted" maxLength={BIO_MAX} multiline onChangeText={setBio} placeholder="A little about you" placeholderTextColor={c.faint} selectionColor={c.brand} style={[field, { paddingVertical: 12, textAlignVertical: "top" }]} value={bio} />
        <Text className="self-end text-[12px] text-muted-foreground">
          {[...bio].length}/{BIO_MAX}
        </Text>
      </View>
      {error ? <Notice text={error} /> : null}
      <Button disabled={busy} onPress={() => void save()}>
        {busy ? "Saving…" : "Save profile"}
      </Button>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View className="rounded-[14px] bg-muted px-3.5 py-3" style={{ width: "48.5%" }}>
      <Text className="text-[12px] text-muted-foreground">{label}</Text>
      <Text className="font-semibold text-[17px] text-foreground" style={figures}>
        {value}
      </Text>
    </View>
  );
}
function Notice({ text }: { text: string }) {
  return (
    <View className="rounded-[14px] bg-muted px-4 py-3">
      <Text className="text-[13px] text-muted-foreground leading-[19px]">{text}</Text>
    </View>
  );
}
