"use client";

import { PauseIcon, PlayIcon, RotateCcwIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const clock = (s: number) => {
  const n = Math.max(0, Math.floor(s));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
};

/**
 * The clip with the app's own controls: play or pause by the button or the picture, drag the line
 * to scrub, replay when it ends. Silent, so no volume.
 */
export function ClipPlayer({ src, className }: { src: string; className?: string }) {
  const video = useRef<HTMLVideoElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(true);
  const [ended, setEnded] = useState(false);
  const [time, setTime] = useState(0);
  const [length, setLength] = useState(0);
  const scrubbing = useRef(false);

  useEffect(() => {
    const v = video.current;
    if (!v) return;
    // A blob loads in a beat, but the duration is not known until it does.
    const onMeta = () => setLength(v.duration || 0);
    const onTime = () => {
      if (!scrubbing.current) setTime(v.currentTime);
    };
    const onPlay = () => {
      setPlaying(true);
      setEnded(false);
    };
    const onPause = () => setPlaying(false);
    const onEnded = () => {
      setEnded(true);
      setPlaying(false);
      setTime(v.duration || 0);
    };
    v.addEventListener("loadedmetadata", onMeta);
    v.addEventListener("durationchange", onMeta);
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    v.addEventListener("ended", onEnded);
    return () => {
      v.removeEventListener("loadedmetadata", onMeta);
      v.removeEventListener("durationchange", onMeta);
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("ended", onEnded);
    };
  }, []);

  // A smoother needle than timeupdate's four a second, while it plays.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const v = video.current;
      if (v && !scrubbing.current) setTime(v.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const toggle = () => {
    const v = video.current;
    if (!v) return;
    if (ended) {
      v.currentTime = 0;
      void v.play();
      return;
    }
    if (v.paused) void v.play();
    else v.pause();
  };

  const seekTo = (clientX: number) => {
    const v = video.current;
    const el = track.current;
    if (!v || !el || !length) return;
    const r = el.getBoundingClientRect();
    const u = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    v.currentTime = u * length;
    setTime(u * length);
    setEnded(false);
  };

  const onTrackDown = (e: React.PointerEvent<HTMLDivElement>) => {
    scrubbing.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    seekTo(e.clientX);
  };
  const onTrackMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (scrubbing.current) seekTo(e.clientX);
  };
  const onTrackUp = (e: React.PointerEvent<HTMLDivElement>) => {
    scrubbing.current = false;
    e.currentTarget.releasePointerCapture(e.pointerId);
  };
  const onTrackKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const v = video.current;
    if (!v || !length) return;
    const step = length / 20;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") v.currentTime = Math.min(length, v.currentTime + step);
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") v.currentTime = Math.max(0, v.currentTime - step);
    else if (e.key === "Home") v.currentTime = 0;
    else if (e.key === "End") v.currentTime = length;
    else if (e.key === " " || e.key === "Enter") toggle();
    else return;
    e.preventDefault();
    setTime(v.currentTime);
  };

  const done = length ? Math.min(1, time / length) : 0;

  return (
    <div className={cn("flex flex-col", className)}>
      {/* biome-ignore lint/a11y/useMediaCaption: a silent clip of the chart above */}
      <video autoPlay className="block aspect-video w-full cursor-pointer bg-background" muted onClick={toggle} playsInline ref={video} src={src} />
      <div className="flex items-center gap-3 border-t px-2 py-1.5">
        <Button aria-label={ended ? "Play again" : playing ? "Pause" : "Play"} className="size-8 rounded-full" onClick={toggle} size="icon-sm" variant="ghost">
          {ended ? <RotateCcwIcon /> : playing ? <PauseIcon /> : <PlayIcon />}
        </Button>
        {/* The line is the control. Its filled part is how far in you are. */}
        <div
          aria-label="Where you are in the clip"
          aria-valuemax={Math.round(length * 10) / 10}
          aria-valuemin={0}
          aria-valuenow={Math.round(time * 10) / 10}
          className="group relative flex h-8 flex-1 cursor-pointer items-center outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-full"
          onKeyDown={onTrackKey}
          onPointerDown={onTrackDown}
          onPointerMove={onTrackMove}
          onPointerUp={onTrackUp}
          ref={track}
          role="slider"
          tabIndex={0}
        >
          <div className="h-1 w-full rounded-full bg-muted-foreground/20" />
          <div className="absolute inset-y-0 left-0 my-auto h-1 rounded-full bg-brand" style={{ width: `${done * 100}%` }} />
          <div
            className="absolute size-3 rounded-full bg-brand ring-2 ring-background transition-transform group-hover:scale-110"
            style={{ left: `calc(${done * 100}% - 6px)` }}
          />
        </div>
        <span className="figures text-muted-foreground text-xs tabular-nums">
          {clock(time)} <span className="opacity-60">/ {clock(length)}</span>
        </span>
      </div>
    </div>
  );
}
