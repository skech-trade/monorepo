import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { PlayerProfile } from "@skech/core/social";
import { bindPen, cacheProfile, connectSocial, type DrawingAudience, setDrawingAudience, setSocialViewer, socialRequest } from "@/lib/social";
import { useAccount } from "./auth";
import { SocialSheet, type SocialTab } from "./sheets/social-sheet";

/**
 * The community around the game, as on the web (social-provider.tsx): one live stream for the app, who the player
 * follows, and the sheet with the leaderboard, who is playing, and profiles. The game screen does not subscribe to
 * the stream: the stage reads it each frame (lib/social.ts), so a busy feed costs the game nothing.
 */
type Community = { open: (tab?: SocialTab, player?: string) => void; audience: DrawingAudience; changeAudience: (value: DrawingAudience) => void; refreshFollowing: () => void };
const Ctx = createContext<Community | null>(null);
export const useCommunity = () => useContext(Ctx);

export function SocialProvider({ children }: { children: ReactNode }) {
  const me = useAccount();
  const player = me.address;
  const [panel, setPanel] = useState<{ tab: SocialTab; player?: string } | null>(null);
  const [audience, setAudience] = useState<DrawingAudience>("everyone");
  const [version, refresh] = useState(0);
  const open = useCallback((tab: SocialTab = "leaderboard", target?: string) => setPanel({ tab, player: target }), []);
  useEffect(() => connectSocial(), []);
  // Others see this player's pen as it draws. Privy signs for it without asking; a wallet on the phone would ask, so
  // its player says so in the community sheet (a day's ticket after).
  const sign = me.signMessage;
  const silent = me.kind === "privy";
  useEffect(() => bindPen(player, player && silent ? sign : null), [player, sign, silent]);
  useEffect(() => {
    if (!player) {
      setSocialViewer(null, []);
      return;
    }
    const controller = new AbortController();
    setSocialViewer(player, []);
    void socialRequest<{ profile: PlayerProfile }>(`/identity?player=${player}`, undefined, controller.signal).then((r) => cacheProfile(r.profile), () => undefined);
    void socialRequest<{ players: string[] }>(`/following?player=${player}`, undefined, controller.signal).then((r) => setSocialViewer(player, r.players), () => undefined);
    return () => controller.abort();
  }, [player, version]);
  const value = useMemo<Community>(
    () => ({
      open,
      audience,
      changeAudience(next) {
        setAudience(next);
        setDrawingAudience(next);
      },
      refreshFollowing() {
        refresh((v) => v + 1);
      },
    }),
    [open, audience],
  );
  return (
    <Ctx.Provider value={value}>
      {children}
      {panel ? <SocialSheet initialPlayer={panel.player} initialTab={panel.tab} onClose={() => setPanel(null)} /> : null}
    </Ctx.Provider>
  );
}
