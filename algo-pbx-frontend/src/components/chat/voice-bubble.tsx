"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

function fmt(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// A WhatsApp-Web-style voice-note player: circular play/pause, a scrubber
// with a draggable head, elapsed / total time, and a 1x/1.5x/2x speed
// toggle. Uses a hidden <audio> element for actual playback; the src is a
// same-origin auth-checked proxy (/api/messaging/media/[id]).
export function VoiceBubble({ src, outbound }: { src: string; outbound: boolean }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [cur, setCur] = useState(0);
  const [dur, setDur] = useState(0);
  const [rate, setRate] = useState(1);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const onTime = () => setCur(a.currentTime);
    const onMeta = () => setDur(a.duration);
    const onEnd = () => {
      setPlaying(false);
      setCur(0);
    };
    a.addEventListener("timeupdate", onTime);
    a.addEventListener("loadedmetadata", onMeta);
    a.addEventListener("durationchange", onMeta);
    a.addEventListener("ended", onEnd);
    a.addEventListener("error", () => setFailed(true));
    return () => {
      a.removeEventListener("timeupdate", onTime);
      a.removeEventListener("loadedmetadata", onMeta);
      a.removeEventListener("durationchange", onMeta);
      a.removeEventListener("ended", onEnd);
    };
  }, []);

  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = rate;
  }, [rate]);

  const toggle = () => {
    const a = audioRef.current;
    if (!a) return;
    if (playing) {
      a.pause();
      setPlaying(false);
    } else {
      a.play().then(() => setPlaying(true)).catch(() => setFailed(true));
    }
  };

  const seek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const a = audioRef.current;
    if (!a || !Number.isFinite(dur)) return;
    a.currentTime = (Number(e.target.value) / 100) * dur;
    setCur(a.currentTime);
  };

  const pct = dur > 0 ? Math.min(100, (cur / dur) * 100) : 0;
  const onAccent = outbound;

  if (failed) {
    return (
      <a
        href={src}
        target="_blank"
        rel="noreferrer"
        className="mt-1 block text-xs font-medium underline"
      >
        Voice message — open
      </a>
    );
  }

  return (
    <div
      className={cn(
        "mt-1 flex w-[15rem] max-w-full items-center gap-2.5 rounded-[var(--radius)] px-2 py-2",
        onAccent ? "bg-canvas/15" : "bg-surface-subtle"
      )}
    >
      <audio ref={audioRef} src={src} preload="metadata" className="hidden" />
      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? "Pause voice message" : "Play voice message"}
        className={cn(
          "flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full",
          onAccent ? "bg-accent-fg text-accent" : "bg-accent text-accent-fg"
        )}
      >
        {playing ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <rect x="6" y="5" width="4" height="14" rx="1" />
            <rect x="14" y="5" width="4" height="14" rx="1" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d="M8 5v14l11-7z" />
          </svg>
        )}
      </button>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <input
          type="range"
          min={0}
          max={100}
          value={pct}
          onChange={seek}
          aria-label="Seek"
          className={cn(
            "h-1 w-full cursor-pointer appearance-none rounded-full",
            onAccent ? "bg-accent-fg/30 accent-accent-fg" : "bg-surface-hover accent-accent"
          )}
          style={{
            background: onAccent
              ? `linear-gradient(to right, rgb(var(--text-on-accent)) ${pct}%, rgb(var(--text-on-accent) / 0.3) ${pct}%)`
              : `linear-gradient(to right, rgb(var(--accent)) ${pct}%, rgb(var(--surface-hover)) ${pct}%)`,
          }}
        />
        <div
          className={cn(
            "flex items-center justify-between text-[10px]",
            onAccent ? "text-accent-fg/70" : "text-tertiary"
          )}
        >
          <span>{fmt(playing || cur > 0 ? cur : dur)}</span>
          <button
            type="button"
            onClick={() => setRate((r) => (r === 1 ? 1.5 : r === 1.5 ? 2 : 1))}
            className="rounded px-1 font-medium hover:opacity-80"
            aria-label="Playback speed"
          >
            {rate}×
          </button>
        </div>
      </div>
    </div>
  );
}
