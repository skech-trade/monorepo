"use client";

import type { PlayerState } from "@/lib/social";

const BADGES: Record<string, string> = {
  founding_skecher: "Founding skecher",
  first_prediction: "First prediction",
  five_predictions: "Five predictions",
  sharp_eye: "Sharp eye",
};

/** Where each level starts, in points. The API says where the next one does. */
const LEVEL_FLOORS = [0, 100, 250, 500, 1000, 2000];

export function PlayerCard({ social }: { social: PlayerState }) {
  const p = social.player;
  if (!p) return null;
  const floor = LEVEL_FLOORS[p.level - 1] ?? 0;
  const progress = p.nextLevelAt ? Math.min(100, Math.max(0, ((p.points - floor) / (p.nextLevelAt - floor)) * 100)) : 100;
  return (
    <section aria-label="Your progress" className="space-y-4 border-b px-6 py-6 sm:px-7">
      <div className="flex items-center justify-between gap-3">
        <h3 className="truncate text-sm font-semibold">@{p.username}</h3>
        <span className="shrink-0 rounded-full bg-primary/10 px-3 py-1 text-xs font-medium">Level {p.level}</span>
      </div>
      <div className="flex items-end justify-between gap-2">
        <p className="text-2xl font-semibold tabular-nums">
          {p.points} <span className="text-sm font-normal text-muted-foreground">points</span>
        </p>
        <span className="text-xs text-muted-foreground">{p.nextLevelAt ? `${p.nextLevelAt - p.points} to next level` : "Top level"}</span>
      </div>
      <div
        role="progressbar"
        aria-label="Level progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress)}
        className="h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <div className="h-full rounded-full bg-primary" style={{ width: `${progress}%` }} />
      </div>
      <div className="flex flex-wrap gap-2">
        {p.achievements.map((a) => (
          <span key={a} className="rounded-full border px-2.5 py-1 text-xs">
            {BADGES[a] ?? a}
          </span>
        ))}
      </div>
      <details className="text-xs leading-relaxed text-muted-foreground">
        <summary className="cursor-pointer py-1">How points work · {p.dailyRemaining} predictions left today</summary>
        <p className="pt-2">
          Earn 20 points for a completed 10–300 second prediction, plus 10 for at least 70% direction accuracy. Up to three per UTC day. Editing or closing a trade does not change the original scored prediction. Points have no cash value; deposits, stake and leverage do not earn points.
        </p>
      </details>
      {social.note ? (
        <p role="status" className="text-xs leading-relaxed text-muted-foreground">
          {social.note}
        </p>
      ) : null}
    </section>
  );
}
