"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { useAccount } from "@/components/app/auth";
import { cacheProfile, connectSocial, onSocialActivity, setDrawingAudience, setSocialViewer, socialRequest, type DrawingAudience } from "@/lib/social";
import { playerName, type PlayerProfile } from "@skech/core/social";
import { toastManager } from "@/components/ui/toast";

const SocialSheet = dynamic(() => import("./social-sheet").then(module => module.SocialSheet), { ssr: false });
type SocialContext = { open: (tab?: "leaderboard" | "activity" | "profile", player?: string) => void; audience: DrawingAudience; changeAudience: (value: DrawingAudience) => void; refreshFollowing: () => void };
const noFollowing: string[] = [];
const Context = createContext<SocialContext | null>(null);
export const useCommunity = () => useContext(Context);

export function SocialProvider({ children }: { children: ReactNode }) {
  const notified = useRef(new Set<string>());
  const me = useAccount();
  const player = me.address?.toLowerCase() ?? null;
  const [panel, setPanel] = useState<{ tab: "leaderboard" | "activity" | "profile"; player?: string; drawing?: string } | null>(null);
  const [audience, setAudience] = useState<DrawingAudience>("everyone");
  const [followed, setFollowed] = useState<{ player: string; targets: string[] } | null>(null);
  const following = followed?.player === player ? followed.targets : noFollowing;
  const [version, refresh] = useState(0);
  const open = useCallback((tab: "leaderboard" | "activity" | "profile" = "leaderboard", target?: string) => setPanel({ tab, player: target }), []);
  useEffect(() => connectSocial(), []);
  useEffect(() => {
    const controller = new AbortController();
    if (!player) { setSocialViewer(null, []); return; }
    setSocialViewer(player, []);
    void socialRequest<{ profile: PlayerProfile }>(`/identity?player=${player}`, undefined, controller.signal).then(result => { if (!controller.signal.aborted) cacheProfile(result.profile); }, () => undefined);
    void socialRequest<{ players: string[] }>(`/following?player=${player}`, undefined, controller.signal).then(result => { if (!controller.signal.aborted) { setFollowed({ player, targets: result.players }); setSocialViewer(player, result.players); } }, () => undefined);
    return () => controller.abort();
  }, [player, version]);
  useEffect(() => {
    const profile = (event: Event) => open("profile", (event as CustomEvent<string>).detail);
    const drawing = (event: Event) => setPanel({ tab: "activity", drawing: (event as CustomEvent<string>).detail });
    window.addEventListener("skech:profile", profile); window.addEventListener("skech:drawing", drawing);
    const query = new URLSearchParams(window.location.search);
    const target = query.get("player"), id = query.get("drawing");
    const navigate = () => { if (id) setPanel({ tab: "activity", drawing: id }); else if (target && /^0x[0-9a-f]{40}$/i.test(target)) open("profile", target); };
    // URL handoff runs after hydration, so the sheet never differs from the server shell.
    const frame = requestAnimationFrame(navigate);
    return () => { cancelAnimationFrame(frame); window.removeEventListener("skech:profile", profile); window.removeEventListener("skech:drawing", drawing); };
  }, [open]);
  useEffect(() => onSocialActivity(activity => {
    if (!following.includes(activity.player) || activity.kind !== "settled" || !activity.complete) return;
    try { if (localStorage.getItem("skech:social:alerts") === "off") return; } catch {}
    if (notified.current.has(activity.drawing)) return;
    notified.current.add(activity.drawing); if (notified.current.size > 500) notified.current.delete(notified.current.values().next().value!);
    toastManager.add({ title: `${playerName(activity.profile)} finished a drawing`, description: "See their result in Live activity.", timeout: 4000 });
  }), [following]);
  return <Context.Provider value={{ open, audience, changeAudience(value) { setAudience(value); setDrawingAudience(value); }, refreshFollowing() { refresh(v => v + 1); } }}>
    {children}
    {panel ? <SocialSheet initialTab={panel.tab} initialPlayer={panel.player} initialDrawing={panel.drawing} onClose={() => setPanel(null)} /> : null}
  </Context.Provider>;
}
