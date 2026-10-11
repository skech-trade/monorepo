"use client";

import { playerHue, playerName, type PlayerProfile } from "@skech/core/social";
import { focusPlayer, useFocusedPlayer, useSocial } from "@/lib/social";
import { cn } from "@/lib/utils";
import { PlayerAvatar } from "@/components/app/player-avatar";
import styles from "./presence-rail.module.css";

/**
 * Who is drawing, over the chart they are drawing on.
 *
 * The community used to live in a drawer, which covered the one thing it was about: other players' ink arrives on
 * your chart, and opening the sheet to look at them hid it. This sits on the chart instead and never takes it away.
 *
 * Each face is ringed in that player's own hue, the same `playerHue` the canvas paints their ink with, so the ring
 * and the line are visibly the same person without anything having to say so. Pressing a face lights their ink and
 * pushes everyone else's back; pressing it again lets the chart go.
 */

const MOST = 8;

export function PresenceRail({ className }: { className?: string }) {
  const { playing, connected } = useSocial();
  const focused = useFocusedPlayer();
  if (!connected || !playing.length) return null;
  const shown = playing.slice(0, MOST);
  const more = playing.length - shown.length;
  return (
    <div className={cn(styles.rail, className)}>
      <span className={styles.count}>
        <span className={styles.pulse} />
        <strong className="figures">{playing.length}</strong> drawing
      </span>
      <div className={styles.faces}>
        {shown.map((p) => (
          <Face focused={focused} key={p.player} profile={p} />
        ))}
        {more > 0 ? <span className={styles.more}>+{more}</span> : null}
      </div>
      {focused ? (
        <button className={styles.release} onClick={() => focusPlayer(null)} type="button">
          Show everyone
        </button>
      ) : null}
    </div>
  );
}

function Face({ profile, focused }: { profile: PlayerProfile; focused: string | null }) {
  const mine = focused === profile.player;
  const dimmed = focused !== null && !mine;
  return (
    <button
      aria-label={`${mine ? "Stop following" : "Follow"} ${playerName(profile)}'s line`}
      aria-pressed={mine}
      className={cn(styles.face, dimmed && styles.dimmed)}
      onClick={() => focusPlayer(profile.player)}
      /* The ring is the line: the hue is the one the canvas paints this player's ink with. */
      style={{ "--hue": playerHue(profile.player) } as React.CSSProperties}
      title={playerName(profile)}
      type="button"
    >
      <PlayerAvatar className={styles.avatar} profile={profile} />
    </button>
  );
}
