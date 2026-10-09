"use client";

import { ArrowLeftIcon, CheckIcon, RadioIcon, Share2Icon, TrophyIcon, UserIcon, UsersIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { playerHue, playerName, type LeaderboardRow, type PlayerProfile, type ProfileResponse, type PublicDrawing, type SocialWindow } from "@skech/core/social";
import { useAccount } from "@/components/app/auth";
import { useGate } from "./deposit-modal";
import { useCommunity } from "./social-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Sheet, SheetDescription, SheetHeader, SheetPanel, SheetPopup, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { avatarUrl, socialAction, socialMoney, socialRequest, useSocial } from "@/lib/social";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "../theme-toggle";
import { explorer } from "@/lib/chain";

const tabletPortrait = "(min-width: 640px) and (max-width: 1023px) and (orientation: portrait)";
const subscribeTablet = (callback: () => void) => { const media = matchMedia(tabletPortrait); media.addEventListener("change", callback); return () => media.removeEventListener("change", callback); };

type Tab = "leaderboard" | "activity" | "profile";
const windows: { value: SocialWindow; label: string }[] = [{ value: "24h", label: "24h" }, { value: "7d", label: "7d" }, { value: "30d", label: "30d" }, { value: "all", label: "All time" }];
const quietCard = "rounded-[18px] bg-muted";

export function PlayerAvatar({ profile, className }: { profile: PlayerProfile; className?: string }) {
  return <Avatar className={cn("size-10 ring-1 ring-foreground/5", className)}>
    <AvatarImage src={avatarUrl(profile)} alt="" />
    <AvatarFallback className="font-semibold text-white" style={{ background: `linear-gradient(135deg, oklch(.72 .12 ${playerHue(profile.player)}), oklch(.52 .14 ${playerHue(profile.player) + 45}))` }}>{playerName(profile).slice(0, 1).toUpperCase()}</AvatarFallback>
  </Avatar>;
}

export function SocialSheet({ initialTab, initialPlayer, initialDrawing, onClose }: { initialTab: Tab; initialPlayer?: string; initialDrawing?: string; onClose: () => void }) {
  const tablet = useSyncExternalStore(subscribeTablet, () => matchMedia(tabletPortrait).matches, () => false);
  const me = useAccount();
  const social = useSocial();
  const community = useCommunity();
  const gate = useGate();
  const [tab, setTab] = useState<Tab>(initialTab);
  const [player, setPlayer] = useState(initialPlayer?.toLowerCase() ?? me.address?.toLowerCase() ?? null);
  const [drawing, setDrawing] = useState<string | null>(initialDrawing ?? null);
  const [window, setWindow] = useState<SocialWindow>("all");
  const [friends, setFriends] = useState(false);
  const [board, setBoard] = useState<{ rows: LeaderboardRow[]; me: LeaderboardRow | null; counting: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [alerts, setAlerts] = useState(() => { try { return localStorage.getItem("skech:social:alerts") !== "off"; } catch { return true; } });
  const viewer = me.address?.toLowerCase() ?? "";
  useEffect(() => {
    if (tab !== "leaderboard" || drawing) return;
    const controller = new AbortController();
    let pending = false;
    const load = async () => {
      if (pending) return;
      pending = true;
      try { const result = await socialRequest<NonNullable<typeof board>>(`/leaderboard?window=${window}&viewer=${viewer}&friends=${friends ? "1" : "0"}`, undefined, controller.signal); if (!controller.signal.aborted) { setBoard(result); setError(null); } }
      catch { if (!controller.signal.aborted) setError("The leaderboard is unavailable right now. Try again shortly."); }
      finally { pending = false; }
    };
    void load(); const interval = setInterval(() => { if (!document.hidden) void load(); }, 5000);
    return () => { controller.abort(); clearInterval(interval); };
  }, [tab, window, viewer, friends, drawing]);
  const viewPlayer = (target: string) => { setPlayer(target); setDrawing(null); setTab("profile"); };
  return <Sheet open onOpenChange={open => { if (!open) onClose(); }}>
    <SheetPopup side={tablet ? "bottom" : "right"} variant="inset" className={cn("rounded-t-3xl motion-reduce:transition-none sm:rounded-2xl", tablet ? "mx-auto max-h-[85dvh] max-w-xl" : "sm:max-w-md")} closeProps={{ className: "absolute end-2 top-2 min-h-11 min-w-11" }}>
      <SheetHeader className="px-5 pt-6 sm:px-6 sm:pt-8">
        <SheetTitle className="font-bold text-xl">{drawing ? "The drawing" : tab === "profile" ? player === viewer ? "Your profile" : "Player profile" : "Draw together"}</SheetTitle>
        <SheetDescription>{drawing ? "Every piece, one result." : "People, ink, and what happened next."}</SheetDescription>
      </SheetHeader>
      <SheetPanel className="flex flex-col gap-4 px-5 pb-[max(2rem,env(safe-area-inset-bottom))] sm:px-6">
        {drawing ? <DrawingDetail id={drawing} onBack={() => setDrawing(null)} onPlayer={viewPlayer} /> : <>
          <div className="flex rounded-full bg-muted p-1" role="group" aria-label="Community">
            {([{ value: "leaderboard", label: "Leaderboard", icon: TrophyIcon }, { value: "activity", label: "Live", icon: RadioIcon }, { value: "profile", label: "Profile", icon: UserIcon }] as const).map(item => <button key={item.value} aria-pressed={tab === item.value} type="button" onClick={() => { setTab(item.value); if (item.value === "profile") setPlayer(viewer || null); }} className={cn("flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-full text-[13px] font-semibold transition-colors", tab === item.value ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground")}><item.icon className="size-3.5" />{item.label}</button>)}
          </div>
          {tab !== "activity" ? <div className="flex gap-1.5" aria-label="Time period">{windows.map(item => <button key={item.value} type="button" aria-pressed={window === item.value} onClick={() => setWindow(item.value)} className={cn("min-h-11 flex-1 rounded-full text-[13px] font-medium transition-colors", window === item.value ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-muted")}>{item.label}</button>)}</div> : null}
          {tab === "leaderboard" ? <>
            <div className="flex items-center justify-between px-1"><span className="text-[13px] text-muted-foreground">Ranked by net PnL</span><button type="button" className="flex min-h-11 items-center gap-1.5 text-[13px] font-medium" aria-pressed={friends} onClick={() => viewer ? setFriends(v => !v) : gate.openSignIn("play")}><UsersIcon className="size-3.5" />{friends ? "Following" : "Everyone"}</button></div>
            {board?.counting || social.counting ? <p className="text-[13px] text-muted-foreground">Reading earlier drawings… rankings will update as history arrives.</p> : null}
            {error ? <Notice text={error} /> : !board ? <LoadingRows /> : !board.rows.length ? <Empty text={friends ? "Follow a player to see them here." : "The first drawings will start the board."} /> : <div className={cn(quietCard, "divide-y divide-border overflow-hidden")}>{board.rows.map(row => <LeaderRow key={row.profile.player} row={row} me={viewer === row.profile.player} onClick={() => viewPlayer(row.profile.player)} />)}</div>}
            {board?.me && !board.rows.some(row => row.profile.player === viewer) ? <div className={quietCard}><LeaderRow row={board.me} me onClick={() => viewPlayer(viewer)} /></div> : null}
            <p className="px-1 text-xs leading-relaxed text-muted-foreground">PnL includes earned payouts and earned IOUs, minus settled stakes. Open ink has no final result yet.</p>
          </> : tab === "activity" ? <>
            <div className="flex items-center gap-2 px-1 text-[13px] text-muted-foreground"><span className={cn("size-1.5 rounded-full", social.connected ? "bg-success" : "bg-muted-foreground")} />{social.connected ? "Live drawings" : "Reconnecting to live activity…"}</div>
            <div className={cn(quietCard, "p-3")}><span className="text-xs text-muted-foreground">Ink on your chart</span><div className="mt-2 flex gap-1">{([{ value: "everyone", label: "Everyone" }, { value: "following", label: "Following" }, { value: "me", label: "Only me" }] as const).map(item => <button type="button" aria-pressed={community?.audience === item.value} key={item.value} onClick={() => community?.changeAudience(item.value)} className={cn("min-h-11 flex-1 rounded-full text-[13px] font-medium", community?.audience === item.value ? "bg-background shadow-sm" : "text-muted-foreground")}>{item.label}</button>)}</div></div>
            {social.activity.length ? <div className={cn(quietCard, "divide-y divide-border overflow-hidden")}>{social.activity.map(item => <div key={item.id} className="flex items-center gap-3 px-3.5 py-3"><button type="button" aria-label={`Open ${playerName(item.profile)}'s profile`} onClick={() => viewPlayer(item.player)}><PlayerAvatar profile={item.profile} className="size-9" /></button><button type="button" onClick={() => setDrawing(item.drawing)} className="flex min-w-0 flex-1 items-center justify-between gap-2 text-left"><span className="flex min-w-0 flex-col"><strong className="truncate text-sm font-medium">{playerName(item.profile)}</strong><span className="text-xs text-muted-foreground">{item.kind === "placed" ? "Placed a drawing" : item.complete ? "Drawing finished" : "Ink settled"} · {new Date(item.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span></span><span className={cn("figures shrink-0 text-sm font-semibold", item.kind === "settled" && BigInt(item.amount) > 0n && "text-success-foreground")}>{socialMoney(item.amount, item.kind === "settled")}</span></button></div>)}</div> : <Empty text="New drawings and results will appear here." />}
            <div className="flex min-h-11 items-center justify-between px-1 text-[13px]"><span>Appearance</span><ThemeToggle className="size-11 rounded-full" /></div>
            <label className="flex min-h-11 items-center justify-between gap-3 px-1 text-[13px]">Alerts for players you follow<input type="checkbox" checked={alerts} onChange={event => { setAlerts(event.target.checked); try { localStorage.setItem("skech:social:alerts", event.target.checked ? "on" : "off"); } catch {} }} className="size-5 accent-brand" /></label>
          </> : player ? <ProfileView key={`${player}:${window}`} player={player} window={window} onDrawing={setDrawing} /> : <div className="flex flex-col items-start gap-3 rounded-[18px] bg-muted p-4"><p className="text-sm text-muted-foreground">Sign in to make your profile and keep your drawing history.</p><Button onClick={() => gate.openSignIn("play")} className="rounded-full">Sign in</Button></div>}
        </>}
      </SheetPanel>
    </SheetPopup>
  </Sheet>;
}

function LeaderRow({ row, me, onClick }: { row: LeaderboardRow; me: boolean; onClick: () => void }) {
  return <button type="button" onClick={onClick} className={cn("flex w-full items-center gap-3 px-3.5 py-3 text-left transition-colors hover:bg-foreground/5", me && "bg-brand/5")}><span className="figures w-5 text-center text-[13px] text-muted-foreground">{row.rank}</span><PlayerAvatar profile={row.profile} className="size-9" /><span className="flex min-w-0 flex-1 flex-col"><strong className="truncate text-sm font-medium">{playerName(row.profile)}{me ? <span className="ml-1 text-xs text-muted-foreground">you</span> : null}</strong><span className="text-xs text-muted-foreground">{row.stats.completed} finished drawings</span></span><span className={cn("figures text-sm font-semibold", BigInt(row.stats.pnl) > 0n && "text-success-foreground")}>{socialMoney(row.stats.pnl, true)}</span></button>;
}

function ProfileView({ player, window, onDrawing }: { player: string; window: SocialWindow; onDrawing: (id: string) => void }) {
  const me = useAccount(), community = useCommunity(), gate = useGate();
  const viewer = me.address?.toLowerCase() ?? "", own = viewer === player;
  const [data, setData] = useState<ProfileResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    const controller = new AbortController(); mounted.current = true;
    void socialRequest<ProfileResponse>(`/profile?player=${player}&viewer=${viewer}&window=${window}`, undefined, controller.signal).then(result => { if (!controller.signal.aborted) setData(result); }, () => { if (!controller.signal.aborted) setError("This profile is unavailable right now. Try again shortly."); });
    return () => { mounted.current = false; controller.abort(); };
  }, [player, viewer, window]);
  const follow = async () => {
    if (!viewer) return gate.openSignIn("play");
    if (!data || busy) return;
    setBusy(true); setError(null);
    try { await socialAction(viewer, "follow", { target: player, enabled: !data.following }, me.signMessage); if (mounted.current) setData({ ...data, following: !data.following, profile: { ...data.profile, followers: data.profile.followers + (data.following ? -1 : 1) } }); community?.refreshFollowing(); }
    catch (error) { if (mounted.current) setError((error as Error).message); }
    finally { if (mounted.current) setBusy(false); }
  };
  const more = async () => {
    if (!data?.next || busy) return;
    setBusy(true);
    try { const next = await socialRequest<ProfileResponse>(`/profile?player=${player}&viewer=${viewer}&window=${window}&cursor=${encodeURIComponent(data.next)}`); if (mounted.current) setData({ ...data, drawings: [...data.drawings, ...next.drawings], next: next.next }); }
    catch { if (mounted.current) setError("Could not load earlier drawings"); }
    finally { if (mounted.current) setBusy(false); }
  };
  if (!data) return error ? <Notice text={error} /> : <LoadingRows />;
  if (editing) return <EditProfile profile={data.profile} onCancel={() => setEditing(false)} onSaved={profile => { setData({ ...data, profile }); setEditing(false); }} />;
  return <>
    <div className="flex items-center gap-3"><PlayerAvatar profile={data.profile} className="size-14 text-lg" /><div className="min-w-0 flex-1"><h3 className="truncate text-lg font-semibold">{playerName(data.profile)}</h3><p className="text-xs text-muted-foreground">{data.profile.joinedAt ? `Drawing since ${new Date(data.profile.joinedAt).toLocaleDateString([], { month: "short", year: "numeric" })}` : "A fresh page"}</p></div>{own ? <Button size="sm" variant="secondary" className="rounded-full" onClick={() => setEditing(true)}>Edit</Button> : <Button size="sm" variant={data.following ? "secondary" : "default"} className="rounded-full" disabled={busy} onClick={() => void follow()}>{data.following ? "Following" : "Follow"}</Button>}</div>
    {data.profile.bio ? <p className="text-sm leading-relaxed text-muted-foreground">{data.profile.bio}</p> : null}
    <div className="flex items-center gap-4 text-xs text-muted-foreground"><span><strong className="figures text-foreground">{data.profile.followers}</strong> followers</span><span><strong className="figures text-foreground">{data.profile.following}</strong> following</span><ShareButton player={player} /></div>
    {error ? <Notice text={error} /> : null}
    <div className={cn(quietCard, "px-4 pt-4 pb-3")}><span className="text-[13px] text-muted-foreground">Net PnL</span><div className={cn("figures mt-1 text-[38px] font-bold leading-none tracking-[-.02em]", BigInt(data.stats.pnl) > 0n && "text-success-foreground")}>{socialMoney(data.stats.pnl, true)}</div><PnlChart points={data.curve} /></div>
    <div className="grid grid-cols-2 gap-2"><Stat label="Total staked" value={socialMoney(data.stats.staked)} /><Stat label="Win rate" value={data.stats.completed ? `${Math.round(data.stats.wins / data.stats.completed * 100)}%` : "—"} /><Stat label="Finished drawings" value={String(data.stats.completed)} /><Stat label="Biggest profit" value={socialMoney(data.stats.biggest, true)} /></div>
    {BigInt(data.stats.owed) > 0n ? <p className="px-1 text-xs text-muted-foreground">Includes {socialMoney(data.stats.owed)} in earned IOUs. Paid at settlement: {socialMoney(data.stats.paid)}.</p> : null}
    {data.badges.length ? <div className="flex flex-wrap gap-1.5">{data.badges.map(badge => <span key={badge} className="rounded-full bg-brand/10 px-2.5 py-1 text-xs font-medium text-brand">{badge}</span>)}</div> : null}
    <span className="px-1 text-[13px] text-muted-foreground">Drawing history</span>
    {data.drawings.length ? <div className={cn(quietCard, "divide-y divide-border overflow-hidden")}>{data.drawings.map(d => <button key={d.id} type="button" onClick={() => onDrawing(d.id)} className="flex w-full items-center gap-3 px-3.5 py-3 text-left hover:bg-foreground/5"><DrawingPreview drawing={d} className="h-10 w-14 shrink-0 text-brand" /><span className="flex flex-1 flex-col"><span className="text-sm font-medium">{d.complete ? BigInt(d.pnl) > 0n ? "Won" : "Finished" : "In play"}</span><span className="text-xs text-muted-foreground">{new Date(d.at).toLocaleDateString([], { month: "short", day: "numeric" })} · {socialMoney(d.stake)} staked</span></span><span className={cn("figures text-sm font-semibold", BigInt(d.pnl) > 0n && "text-success-foreground")}>{d.complete ? socialMoney(d.pnl, true) : "Pending"}</span></button>)}</div> : <Empty text="Your first drawing will start the story." />}
    {data.next ? <Button disabled={busy} variant="ghost" onClick={() => void more()}>{busy ? "Loading…" : "Earlier drawings"}</Button> : null}
  </>;
}

function EditProfile({ profile, onCancel, onSaved }: { profile: PlayerProfile; onCancel: () => void; onSaved: (profile: PlayerProfile) => void }) {
  const me = useAccount();
  const [username, setUsername] = useState(profile.username ?? ""), [bio, setBio] = useState(profile.bio);
  const [image, setImage] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const chooseAvatar = async (file?: File) => {
    if (!file) return;
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 250_000) return setError("Choose a PNG, JPEG or WebP under 250 KB");
    const reader = new FileReader(); reader.onload = () => { setImage(String(reader.result)); setError(null); }; reader.readAsDataURL(file);
  };
  return <form className="flex flex-col gap-4" onSubmit={async event => {
    event.preventDefault(); if (!me.address || busy) return; setBusy(true); setError(null);
    try { const result = await socialAction<{ profile: PlayerProfile }>(me.address.toLowerCase(), "profile", { username, bio, ...(image !== undefined ? { image } : {}) }, me.signMessage); onSaved(result.profile); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }}>
    <Button type="button" variant="ghost" className="self-start rounded-full" onClick={onCancel}><ArrowLeftIcon />Back to profile</Button>
    <label className="flex flex-col gap-2 text-[13px]">Avatar<input type="file" accept="image/png,image/jpeg,image/webp" onChange={event => void chooseAvatar(event.target.files?.[0])} className="rounded-xl bg-muted p-3 text-xs file:mr-3 file:rounded-full file:border-0 file:bg-secondary file:px-3 file:py-2" /></label>
    {image ? <Avatar className="size-16"><AvatarImage src={image} alt="Your new avatar" /></Avatar> : <PlayerAvatar profile={{ ...profile, avatar: image === null ? false : profile.avatar }} className="size-16" />}
    {profile.avatar || image ? <Button type="button" variant="ghost" size="sm" className="self-start" onClick={() => setImage(null)}>Remove avatar</Button> : null}
    <label className="flex flex-col gap-2 text-[13px]">Username<Input className="min-h-11 text-base" value={username} onChange={event => setUsername(event.target.value.toLowerCase())} minLength={3} maxLength={24} pattern="[a-z][a-z0-9_]{2,23}" required placeholder="your_name" autoComplete="nickname" /></label>
    <label className="flex flex-col gap-2 text-[13px]">Bio<Textarea className="text-base" value={bio} onChange={event => setBio(event.target.value)} maxLength={160} placeholder="A little about you" /><span className="self-end text-xs text-muted-foreground">{bio.length}/160</span></label>
    {error ? <Notice text={error} /> : null}
    <Button type="submit" className="rounded-full" disabled={busy}>{busy ? "Saving…" : "Save profile"}</Button>
  </form>;
}

function DrawingDetail({ id, onBack, onPlayer }: { id: string; onBack: () => void; onPlayer: (player: string) => void }) {
  const social = useSocial();
  const live = social.drawings.find(d => d.id === id);
  const [stored, setStored] = useState<PublicDrawing | null>(null), [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void socialRequest<{ drawing: PublicDrawing | null }>(`/drawing?id=${encodeURIComponent(id)}`, undefined, controller.signal).then(result => { if (!controller.signal.aborted) { setStored(result.drawing); if (!result.drawing) setError("This drawing could not be found"); } }, () => { if (!controller.signal.aborted) setError("Could not load this drawing"); });
    return () => controller.abort();
  }, [id]);
  const d = live ?? stored;
  return <><Button variant="ghost" className="self-start rounded-full" onClick={onBack}><ArrowLeftIcon />Back</Button>{!d ? error ? <Notice text={error} /> : <LoadingRows /> : <>
    <button type="button" className="flex items-center gap-3 text-left" onClick={() => onPlayer(d.player)}><PlayerAvatar profile={d.profile} /><span className="flex flex-col"><strong className="text-sm">{playerName(d.profile)}</strong><span className="text-xs text-muted-foreground">{new Date(d.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span></span></button>
    <div className={cn(quietCard, "flex flex-col gap-3 p-4")}><DrawingPreview drawing={d} className="h-32 w-full text-brand" /><span className="text-[13px] text-muted-foreground">{d.complete ? "Final net result" : "Result so far · ink still in play"}</span><span className={cn("figures text-[38px] font-bold leading-none", BigInt(d.pnl) > 0n && "text-success-foreground")}>{socialMoney(d.pnl, true)}</span></div>
    <div className="grid grid-cols-2 gap-2"><Stat label="Staked" value={socialMoney(d.stake)} /><Stat label="Paid at settlement" value={socialMoney(d.paid)} /><Stat label="Open stake" value={socialMoney((BigInt(d.stake) - BigInt(d.settledStake)).toString())} /><Stat label="Earned as IOUs" value={socialMoney(d.owed)} /></div>
    <ShareButton drawing={d.id} player={d.player} />
    {explorer ? <a href={`${explorer}/tx/${d.tx}`} target="_blank" rel="noopener noreferrer" className="self-start text-[13px] text-muted-foreground underline underline-offset-4">View placement transaction</a> : null}
  </>}</>;
}

export function DrawingPreview({ drawing, className }: { drawing: PublicDrawing; className?: string }) {
  const strokes = drawing.pieces.flatMap(piece => piece.stroke ? [piece.stroke] : []);
  const points = strokes.flatMap(stroke => stroke.pts.map(p => ({ t: stroke.t0 + p.t, p: stroke.p0 + p.p })));
  if (!points.length) return <span className={cn("flex items-center justify-center text-xs text-muted-foreground", className)}>Ink</span>;
  let loT = Infinity, hiT = -Infinity, loP = Infinity, hiP = -Infinity;
  for (const p of points) { loT = Math.min(loT, p.t); hiT = Math.max(hiT, p.t); loP = Math.min(loP, p.p); hiP = Math.max(hiP, p.p); }
  return <svg aria-label="Drawing preview" role="img" viewBox="0 0 160 80" className={className}>{strokes.map((stroke, index) => <path key={index} d={stroke.pts.map((p, i) => `${i ? "L" : "M"}${(10 + (stroke.t0 + p.t - loT) / Math.max(1000, hiT - loT) * 140).toFixed(1)},${(70 - (stroke.p0 + p.p - loP) / Math.max(.01, hiP - loP) * 60).toFixed(1)}`).join(" ")} stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" fill="none" />)}</svg>;
}

function PnlChart({ points }: { points: ProfileResponse["curve"] }) {
  const [selected, setSelected] = useState<number | null>(null);
  if (!points.length) return <p className="mt-3 text-xs text-muted-foreground">Your finished ink will build this line.</p>;
  const values = [0, ...points.map(p => Number(p.pnl) / 1e6)];
  const lo = Math.min(...values), hi = Math.max(...values), span = Math.max(.01, hi - lo);
  const path = values.map((value, i) => `${i ? "L" : "M"}${(4 + i / Math.max(1, values.length - 1) * 312).toFixed(1)},${(76 - (value - lo) / span * 68).toFixed(1)}`).join(" ");
  return <div className="mt-3"><svg viewBox="0 0 320 84" className="h-24 w-full touch-pan-y text-brand" role="img" aria-label="Net profit history" onPointerMove={event => { const rect = event.currentTarget.getBoundingClientRect(); setSelected(Math.max(0, Math.min(points.length - 1, Math.round((event.clientX - rect.left) / rect.width * (points.length - 1))))); }} onPointerLeave={() => setSelected(null)}><path d={path} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" /></svg><p className="figures min-h-4 text-xs text-muted-foreground">{selected !== null ? `${new Date(points[selected].at).toLocaleDateString()} · ${socialMoney(points[selected].pnl, true)}` : "Net returns after settled stakes"}</p></div>;
}
function ShareButton({ player, drawing }: { player: string; drawing?: string }) {
  const [copied, setCopied] = useState(false), [error, setError] = useState(false);
  const share = useCallback(async () => {
    const url = new URL("/fun", location.origin); url.searchParams.set(drawing ? "drawing" : "player", drawing ?? player);
    try {
      if (typeof navigator.share === "function") await navigator.share({ title: drawing ? "A drawing on skech" : "Draw with me on skech", url: url.toString() });
      else { await navigator.clipboard.writeText(url.toString()); setCopied(true); setTimeout(() => setCopied(false), 2000); }
    } catch (error) { if ((error as Error).name !== "AbortError") setError(true); }
  }, [player, drawing]);
  return <button type="button" onClick={() => void share()} className="flex min-h-11 items-center gap-1.5 text-xs font-medium text-muted-foreground">{copied ? <CheckIcon className="size-3.5" /> : <Share2Icon className="size-3.5" />}{copied ? "Link copied" : error ? "Could not share · retry" : drawing ? "Share drawing" : "Share profile"}</button>;
}
function Stat({ label, value }: { label: string; value: string }) { return <div className="rounded-[14px] bg-muted px-3.5 py-3"><span className="text-xs text-muted-foreground">{label}</span><p className="figures text-[17px] font-semibold">{value}</p></div>; }
function Empty({ text }: { text: string }) { return <div className="flex flex-col items-center gap-2 rounded-[18px] bg-muted px-5 py-10 text-center"><UsersIcon className="size-6 text-muted-foreground/60" /><p className="max-w-60 text-sm text-muted-foreground">{text}</p></div>; }
function Notice({ text }: { text: string }) { return <p role="status" className="rounded-[14px] bg-muted px-4 py-3 text-[13px] leading-relaxed text-muted-foreground">{text}</p>; }
function LoadingRows() { return <div aria-label="Loading" className="flex flex-col gap-2">{[0,1,2].map(i => <Skeleton key={i} className="h-16 rounded-[18px]" />)}</div>; }
