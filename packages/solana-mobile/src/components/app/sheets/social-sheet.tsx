import { Image } from 'expo-image'
import * as ImagePicker from 'expo-image-picker'
import { ArrowLeftIcon, Share2Icon } from 'lucide-react-native'
import { memo, useCallback, useEffect, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  ScrollView,
  Share,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native'
import Svg, { Path } from 'react-native-svg'
import {
  playerName,
  type LeaderboardRow,
  type PlayerProfile,
  type ProfileResponse,
  type PublicDrawing,
  type SocialWindow,
} from '@skech/core/social'
import { useAccount } from '../auth'
import { Face } from '../app-bar'
import { useGate } from '../gate'
import { useCommunity } from '../social-provider'
import { Button, Sheet, Switch, useColors } from '@/components/ui'
import { avatarUrl, socialAction, socialMoney, socialRequest, useSocial } from '@/lib/social'
import { readJson, writeJson } from '@/lib/storage'
import { cn } from '@/lib/utils'

const periods: SocialWindow[] = ['24h', '7d', '30d', 'all']
const contentStyle = { paddingHorizontal: 16, paddingBottom: 24, gap: 12 }
export function PlayerAvatar({ profile, size = 36 }: { profile: PlayerProfile; size?: number }) {
  return profile.avatar ? (
    <Image
      source={avatarUrl(profile)}
      contentFit="cover"
      style={{ width: size, height: size, borderRadius: size / 2 }}
    />
  ) : (
    <Face address={profile.player} size={size} />
  )
}
function Note({ children }: { children: string }) {
  return (
    <Text accessibilityLiveRegion="polite" className="px-1 py-2 text-sm text-muted-foreground">
      {children}
    </Text>
  )
}
export function SocialSheet({
  open,
  onClose,
  initialPlayer,
  initialDrawing,
}: {
  open: boolean
  onClose: () => void
  initialPlayer?: string
  initialDrawing?: string
}) {
  const me = useAccount(),
    community = useCommunity(),
    social = useSocial(),
    gate = useGate(),
    c = useColors()
  const { height } = useWindowDimensions()
  const [tab, setTab] = useState<'leaderboard' | 'live' | 'profile'>(initialPlayer ? 'profile' : 'leaderboard')
  const [player, setPlayer] = useState(initialPlayer ?? me.address)
  const [drawing, setDrawing] = useState(initialDrawing ?? null)
  const [period, setPeriod] = useState<SocialWindow>('all')
  const [friends, setFriends] = useState(false)
  const [alerts, setAlerts] = useState(() => readJson<boolean>('social:alerts') !== false)
  const [board, setBoard] = useState<{ rows: LeaderboardRow[]; me: LeaderboardRow | null; counting: boolean } | null>(
    null,
  )
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (tab !== 'leaderboard' || drawing) return
    const controller = new AbortController()
    let pending = false
    async function load() {
      if (pending) return
      pending = true
      try {
        const result = await socialRequest<NonNullable<typeof board>>(
          `/leaderboard?window=${period}&viewer=${me.address ?? ''}&friends=${friends ? 1 : 0}`,
          undefined,
          controller.signal,
        )
        if (!controller.signal.aborted) {
          setBoard(result)
          setError(null)
        }
      } catch {
        if (!controller.signal.aborted) setError('The leaderboard is unavailable. Try again shortly.')
      } finally {
        pending = false
      }
    }
    void load()
    const interval = setInterval(() => void load(), 5000)
    return () => {
      controller.abort()
      clearInterval(interval)
    }
  }, [tab, period, friends, me.address, drawing])
  const viewPlayer = useCallback((target: string) => {
    setPlayer(target)
    setDrawing(null)
    setTab('profile')
  }, [])
  const renderLeader = useCallback(
    ({ item }: { item: LeaderboardRow }) => <Leader row={item} onPlayer={viewPlayer} />,
    [viewPlayer],
  )
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={drawing ? 'The drawing' : tab === 'profile' ? 'Player profile' : 'Draw together'}
      description="People, ink, and what happened next."
      scroll={false}
    >
      <View style={{ height: Math.max(200, height * 0.68), flexShrink: 1 }}>
        {drawing ? (
          <DrawingDetail id={drawing} onBack={() => setDrawing(null)} onPlayer={viewPlayer} />
        ) : (
          <>
            <View className="mx-4 mb-3 flex-row rounded-full bg-muted p-1">
              {(['leaderboard', 'live', 'profile'] as const).map((value) => (
                <Pressable
                  key={value}
                  accessibilityRole="button"
                  accessibilityState={{ selected: tab === value }}
                  onPress={() => {
                    setTab(value)
                    if (value === 'profile') setPlayer(me.address)
                  }}
                  className={cn(
                    'min-h-11 flex-1 items-center justify-center rounded-full',
                    tab === value && 'bg-background',
                  )}
                >
                  <Text className="font-semibold text-[13px] text-foreground">
                    {value === 'leaderboard' ? 'Leaderboard' : value === 'live' ? 'Live' : 'Profile'}
                  </Text>
                </Pressable>
              ))}
            </View>
            {tab !== 'live' ? (
              <View className="mx-4 mb-3 flex-row gap-1">
                {periods.map((value) => (
                  <Pressable
                    key={value}
                    accessibilityRole="button"
                    accessibilityState={{ selected: value === period }}
                    onPress={() => setPeriod(value)}
                    className={cn(
                      'min-h-11 flex-1 items-center justify-center rounded-full',
                      period === value && 'bg-secondary',
                    )}
                  >
                    <Text className="text-[13px] text-foreground">{value === 'all' ? 'All time' : value}</Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
            {tab === 'leaderboard' ? (
              <>
                <View className="mx-5 mb-2 flex-row items-center justify-between">
                  <Text className="text-[13px] text-muted-foreground">Ranked by net PnL</Text>
                  <Button
                    variant="ghost"
                    size="md"
                    onPress={() => (me.address ? setFriends((value) => !value) : gate.openSignIn())}
                  >
                    {friends ? 'Following' : 'Everyone'}
                  </Button>
                </View>
                {error ? (
                  <Note>{error}</Note>
                ) : !board ? (
                  <ActivityIndicator color={c.muted} />
                ) : (
                  <FlatList
                    data={board.rows}
                    keyExtractor={(row) => row.profile.player}
                    renderItem={renderLeader}
                    contentContainerStyle={contentStyle}
                    initialNumToRender={10}
                    windowSize={5}
                    ListEmptyComponent={
                      <Note>
                        {friends ? 'Follow a player to see them here.' : 'The first drawings will start the board.'}
                      </Note>
                    }
                    ListFooterComponent={
                      <>
                        <Note>
                          {board.counting
                            ? 'Reading earlier drawings… rankings will update.'
                            : 'PnL includes payouts and earned IOUs, minus settled stakes.'}
                        </Note>
                        {board.me && !board.rows.some((row) => row.profile.player === me.address) ? (
                          <Leader row={board.me} onPlayer={viewPlayer} />
                        ) : null}
                      </>
                    }
                  />
                )}
              </>
            ) : tab === 'live' ? (
              <>
                <View className="mx-4 mb-3 flex-row gap-1">
                  {(['everyone', 'following', 'me'] as const).map((value) => (
                    <Button
                      key={value}
                      className="flex-1 px-2"
                      textClassName="text-[13px]"
                      size="md"
                      variant={community?.audience === value ? 'secondary' : 'ghost'}
                      onPress={() => community?.changeAudience(value)}
                    >
                      {value === 'me' ? 'Only me' : value === 'following' ? 'Following' : 'Everyone'}
                    </Button>
                  ))}
                </View>
                <FlatList
                  data={social.activity}
                  keyExtractor={(item) => item.id}
                  initialNumToRender={10}
                  windowSize={5}
                  contentContainerStyle={contentStyle}
                  ListHeaderComponent={
                    <View>
                      <Note>{social.connected ? 'Live drawings' : 'Reconnecting to live activity…'}</Note>
                      <View className="min-h-11 flex-row items-center justify-between gap-3 px-1">
                        <Text className="flex-1 text-[13px] text-foreground">Alerts for players you follow</Text>
                        <Switch
                          checked={alerts}
                          onChange={(value) => {
                            setAlerts(value)
                            writeJson('social:alerts', value)
                          }}
                        />
                      </View>
                    </View>
                  }
                  ListEmptyComponent={<Note>New drawings and results will appear here.</Note>}
                  renderItem={({ item }) => (
                    <View className="flex-row items-center gap-3 rounded-[18px] bg-muted p-3">
                      <Pressable
                        accessibilityLabel={`Open ${playerName(item.profile)} profile`}
                        onPress={() => viewPlayer(item.player)}
                        className="min-h-11 min-w-11 items-center justify-center"
                      >
                        <PlayerAvatar profile={item.profile} />
                      </Pressable>
                      <Pressable
                        onPress={() => setDrawing(item.drawing)}
                        className="min-h-11 min-w-0 flex-1 flex-row items-center gap-2"
                      >
                        <View className="min-w-0 flex-1">
                          <Text numberOfLines={1} className="font-semibold text-sm text-foreground">
                            {playerName(item.profile)}
                          </Text>
                          <Text className="text-xs text-muted-foreground">
                            {item.kind === 'placed'
                              ? 'Placed a drawing'
                              : item.complete
                                ? 'Drawing finished'
                                : 'Ink settled'}
                          </Text>
                        </View>
                        <Text className="font-semibold text-sm text-foreground">
                          {socialMoney(item.amount, item.kind === 'settled')}
                        </Text>
                      </Pressable>
                    </View>
                  )}
                />
              </>
            ) : player ? (
              <Profile key={`${player}:${period}`} player={player} period={period} onDrawing={setDrawing} />
            ) : (
              <View className="px-4">
                <Note>Sign in to make your profile and keep your drawing history.</Note>
                <Button onPress={() => gate.openSignIn()}>Sign in</Button>
              </View>
            )}
          </>
        )}
      </View>
    </Sheet>
  )
}
const Leader = memo(function Leader({ row, onPlayer }: { row: LeaderboardRow; onPlayer: (player: string) => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => onPlayer(row.profile.player)}
      className="min-h-16 flex-row items-center gap-3 rounded-[18px] bg-muted px-3 py-3"
    >
      <Text className="w-6 text-center text-[13px] text-muted-foreground">{row.rank}</Text>
      <PlayerAvatar profile={row.profile} />
      <View className="min-w-0 flex-1">
        <Text numberOfLines={1} className="font-semibold text-sm text-foreground">
          {playerName(row.profile)}
        </Text>
        <Text className="text-xs text-muted-foreground">{row.stats.completed} finished drawings</Text>
      </View>
      <Text
        className={cn(
          'font-semibold text-sm',
          BigInt(row.stats.pnl) > 0n ? 'text-success-foreground' : 'text-foreground',
        )}
      >
        {socialMoney(row.stats.pnl, true)}
      </Text>
    </Pressable>
  )
})
function Profile({
  player,
  period,
  onDrawing,
}: {
  player: string
  period: SocialWindow
  onDrawing: (id: string) => void
}) {
  const me = useAccount(),
    community = useCommunity(),
    gate = useGate(),
    c = useColors()
  const [data, setData] = useState<ProfileResponse | null>(null),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [editing, setEditing] = useState(false)
  const [username, setUsername] = useState(''),
    [bio, setBio] = useState(''),
    [image, setImage] = useState<string | null | undefined>()
  useEffect(() => {
    const controller = new AbortController()
    void socialRequest<ProfileResponse>(
      `/profile?player=${player}&viewer=${me.address ?? ''}&window=${period}`,
      undefined,
      controller.signal,
    ).then(
      (result) => {
        if (!controller.signal.aborted) {
          setData(result)
          setUsername(result.profile.username ?? '')
          setBio(result.profile.bio)
        }
      },
      () => {
        if (!controller.signal.aborted) setError('This profile is unavailable. Try again shortly.')
      },
    )
    return () => controller.abort()
  }, [player, me.address, period])
  async function action(kind: 'profile' | 'follow') {
    if (!me.address) return gate.openSignIn()
    if (!data || busy) return
    setBusy(true)
    setError(null)
    try {
      if (kind === 'profile') {
        const result = await socialAction<{ profile: PlayerProfile }>(
          me.address,
          'profile',
          { username, bio, ...(image !== undefined ? { image } : {}) },
          me.signMessage,
        )
        setData({ ...data, profile: result.profile })
        setEditing(false)
      } else {
        await socialAction(me.address, 'follow', { target: player, enabled: !data.following }, me.signMessage)
        setData({
          ...data,
          following: !data.following,
          profile: { ...data.profile, followers: data.profile.followers + (data.following ? -1 : 1) },
        })
        community?.refreshFollowing()
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  async function pickAvatar() {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.4,
        base64: true,
      })
      const asset = result.assets?.[0]
      if (result.canceled || !asset?.base64) return
      if (asset.base64.length > 330_000) return setError('Choose an avatar under 250 KB.')
      setImage(`data:image/${asset.mimeType === 'image/png' ? 'png' : 'jpeg'};base64,${asset.base64}`)
    } catch {
      setError('Could not open your photo library.')
    }
  }
  async function more() {
    if (!data?.next || busy) return
    setBusy(true)
    try {
      const next = await socialRequest<ProfileResponse>(
        `/profile?player=${player}&viewer=${me.address ?? ''}&window=${period}&cursor=${encodeURIComponent(data.next)}`,
      )
      setData({ ...data, drawings: [...data.drawings, ...next.drawings], next: next.next })
    } catch {
      setError('Could not load earlier drawings.')
    } finally {
      setBusy(false)
    }
  }
  if (!data) return error ? <Note>{error}</Note> : <ActivityIndicator color={c.muted} />
  const header = (
    <View className="gap-3">
      <View className="flex-row items-center gap-3">
        <PlayerAvatar profile={data.profile} size={64} />
        <View className="min-w-0 flex-1">
          <Text className="font-bold text-xl text-foreground" numberOfLines={1}>
            {playerName(data.profile)}
          </Text>
          <Text className="text-[13px] text-muted-foreground">
            {data.profile.followers} followers · {data.profile.following} following
          </Text>
        </View>
      </View>
      {data.profile.bio ? <Text className="text-sm text-muted-foreground">{data.profile.bio}</Text> : null}
      <View className="flex-row gap-2">
        <Button
          className="flex-1"
          size="md"
          variant="secondary"
          disabled={busy}
          onPress={() => (player === me.address ? setEditing((value) => !value) : void action('follow'))}
        >
          {player === me.address ? 'Edit profile' : data.following ? 'Following' : 'Follow'}
        </Button>
        <Button
          accessibilityLabel="Share profile"
          size="icon"
          variant="secondary"
          onPress={() =>
            void Share.share({ message: `${playerName(data.profile)} on skech\nskech://community?player=${player}` })
          }
        >
          <Share2Icon size={18} color={c.fg} />
        </Button>
      </View>
      {editing ? (
        <View className="gap-3 rounded-[18px] bg-muted p-4">
          <Text className="text-sm text-foreground">Username</Text>
          <TextInput
            accessibilityLabel="Username"
            value={username}
            onChangeText={(value) => setUsername(value.toLowerCase())}
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={24}
            className="min-h-11 rounded-xl bg-background px-3 text-base text-foreground"
            placeholder="your_name"
            placeholderTextColor={c.muted}
          />
          <Text className="text-sm text-foreground">Bio</Text>
          <TextInput
            accessibilityLabel="Bio"
            value={bio}
            onChangeText={setBio}
            maxLength={160}
            multiline
            className="min-h-20 rounded-xl bg-background px-3 py-3 text-base text-foreground"
          />
          <View className="flex-row gap-2">
            <Button size="md" variant="secondary" onPress={() => void pickAvatar()}>
              Choose photo
            </Button>
            <Button size="md" variant="ghost" onPress={() => setImage(null)}>
              Remove photo
            </Button>
          </View>
          {image ? <Image source={image} style={{ width: 64, height: 64, borderRadius: 32 }} /> : null}
          <Button disabled={busy} onPress={() => void action('profile')}>
            {busy ? 'Saving…' : 'Save profile'}
          </Button>
        </View>
      ) : null}
      {error ? <Note>{error}</Note> : null}
      <View className="flex-row flex-wrap gap-2">
        {[
          ['Net PnL', socialMoney(data.stats.pnl, true)],
          ['Earned', socialMoney((BigInt(data.stats.paid) + BigInt(data.stats.owed)).toString())],
          ['Earned as IOUs', socialMoney(data.stats.owed)],
          ['Drawings', String(data.stats.drawings)],
          ['Wins', String(data.stats.wins)],
          ['Biggest win', socialMoney(data.stats.biggest, true)],
        ].map(([label, value]) => (
          <View key={label} className="gap-1 rounded-[18px] bg-muted p-3" style={{ flexBasis: '47%', flexGrow: 1 }}>
            <Text className="text-xs text-muted-foreground">{label}</Text>
            <Text className="font-semibold text-lg text-foreground" adjustsFontSizeToFit numberOfLines={1}>
              {value}
            </Text>
          </View>
        ))}
      </View>
      {data.curve.length > 1 ? <Curve points={data.curve} /> : null}
      <View className="flex-row flex-wrap gap-2">
        {data.badges.map((badge) => (
          <View key={badge} className="rounded-full bg-brand/10 px-3 py-2">
            <Text className="text-xs text-brand">{badge}</Text>
          </View>
        ))}
      </View>
      <Text className="text-[13px] text-muted-foreground">Drawing history</Text>
    </View>
  )
  return (
    <FlatList
      data={data.drawings}
      keyExtractor={(item) => item.id}
      initialNumToRender={8}
      windowSize={5}
      contentContainerStyle={contentStyle}
      ListHeaderComponent={header}
      ListEmptyComponent={<Note>No drawings in this period yet.</Note>}
      ListFooterComponent={
        data.next ? (
          <Button size="md" disabled={busy} variant="secondary" onPress={() => void more()}>
            {busy ? 'Loading…' : 'Earlier drawings'}
          </Button>
        ) : null
      }
      renderItem={({ item }) => (
        <Pressable
          onPress={() => onDrawing(item.id)}
          className="flex-row items-center gap-3 rounded-[18px] bg-muted p-3"
        >
          <DrawingPreview drawing={item} />
          <View className="flex-1">
            <Text className="font-medium text-sm text-foreground">
              {item.complete ? 'Drawing finished' : 'Open ink'}
            </Text>
            <Text className="text-xs text-muted-foreground">
              {new Date(item.at).toLocaleDateString()} · {socialMoney(item.stake)}
            </Text>
          </View>
          <Text className="font-semibold text-sm text-foreground">{socialMoney(item.pnl, true)}</Text>
        </Pressable>
      )}
    />
  )
}
function Curve({ points }: { points: ProfileResponse['curve'] }) {
  const c = useColors()
  const values = [0, ...points.map((point) => Number(BigInt(point.pnl)) / 1e6)]
  const lo = Math.min(...values),
    hi = Math.max(...values),
    span = hi - lo || 1
  return (
    <View className="rounded-[18px] bg-muted p-3">
      <Text className="mb-2 text-xs text-muted-foreground">Net PnL over time</Text>
      <Svg height={80} width="100%" viewBox="0 0 300 80" accessibilityLabel="Cumulative net profit and loss">
        <Path
          d={values
            .map(
              (value, i) => `${i ? 'L' : 'M'}${4 + (i / (values.length - 1)) * 292},${76 - ((value - lo) / span) * 72}`,
            )
            .join(' ')}
          fill="none"
          stroke={c.brand}
          strokeWidth={2}
        />
      </Svg>
    </View>
  )
}
function DrawingPreview({ drawing, large = false }: { drawing: PublicDrawing; large?: boolean }) {
  const c = useColors()
  const strokes = drawing.pieces.flatMap((piece) => (piece.stroke ? [piece.stroke] : []))
  const points = strokes.flatMap((stroke) =>
    stroke.pts.map((point) => ({ t: stroke.t0 + point.t, p: stroke.p0 + point.p })),
  )
  const t0 = Math.min(...points.map((point) => point.t)),
    t1 = Math.max(...points.map((point) => point.t)),
    p0 = Math.min(...points.map((point) => point.p)),
    p1 = Math.max(...points.map((point) => point.p))
  return (
    <Svg
      width={large ? '100%' : 64}
      height={large ? 160 : 48}
      viewBox="0 0 160 100"
      accessibilityLabel={points.length ? 'Drawing preview' : 'Stroke unavailable in recovered history'}
    >
      {strokes.map((stroke, index) => (
        <Path
          key={index}
          d={stroke.pts
            .map(
              (point, i) =>
                `${i ? 'L' : 'M'}${8 + ((stroke.t0 + point.t - t0) / (t1 - t0 || 1)) * 144},${92 - ((stroke.p0 + point.p - p0) / (p1 - p0 || 1)) * 84}`,
            )
            .join(' ')}
          fill="none"
          stroke={drawing.complete && BigInt(drawing.pnl) > 0n ? c.success : c.brand}
          strokeWidth={4}
          strokeLinecap="round"
        />
      ))}
    </Svg>
  )
}
function DrawingDetail({
  id,
  onBack,
  onPlayer,
}: {
  id: string
  onBack: () => void
  onPlayer: (player: string) => void
}) {
  const social = useSocial(),
    c = useColors()
  const [saved, setSaved] = useState<PublicDrawing | null>(null),
    [error, setError] = useState<string | null>(null)
  const drawing = social.drawings.find((item) => item.id === id) ?? saved
  useEffect(() => {
    const controller = new AbortController()
    void socialRequest<{ drawing: PublicDrawing | null }>(
      `/drawing?id=${encodeURIComponent(id)}`,
      undefined,
      controller.signal,
    ).then(
      (result) => {
        if (!controller.signal.aborted) {
          setSaved(result.drawing)
          if (!result.drawing) setError('Drawing not found.')
        }
      },
      () => {
        if (!controller.signal.aborted) setError('Could not load this drawing.')
      },
    )
    return () => controller.abort()
  }, [id])
  return (
    <ScrollView contentContainerStyle={contentStyle}>
      <Button size="md" variant="ghost" className="self-start" onPress={onBack}>
        <ArrowLeftIcon color={c.fg} size={18} />
        <Text className="text-foreground">Back</Text>
      </Button>
      {error ? (
        <Note>{error}</Note>
      ) : !drawing ? (
        <ActivityIndicator color={c.muted} />
      ) : (
        <>
          <Pressable onPress={() => onPlayer(drawing.player)} className="min-h-11 flex-row items-center gap-3">
            <PlayerAvatar profile={drawing.profile} />
            <Text className="font-semibold text-foreground">{playerName(drawing.profile)}</Text>
          </Pressable>
          <DrawingPreview drawing={drawing} large />
          <Text className="font-bold text-3xl text-foreground">{socialMoney(drawing.pnl, true)}</Text>
          <Note>{`${drawing.complete ? 'Finished' : 'Open ink'} · stake ${socialMoney(drawing.stake)} · paid ${socialMoney(drawing.paid)} · earned IOUs ${socialMoney(drawing.owed)}`}</Note>
          <Button
            size="md"
            variant="secondary"
            onPress={() =>
              void Share.share({
                message: `${playerName(drawing.profile)} drew on skech: ${socialMoney(drawing.pnl, true)}\nskech://community?drawing=${encodeURIComponent(drawing.id)}`,
              })
            }
          >
            Share drawing
          </Button>
        </>
      )}
    </ScrollView>
  )
}
