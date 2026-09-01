"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";

/** Deterministic initials for the fallback disc. */
function initials(label: string): string {
  const clean = label.replace(/[^\p{L}\p{N} ]/gu, " ").trim();
  if (!clean) return "#";
  const parts = clean.split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// WhatsApp-style contact avatar: the real profile picture when the proxy
// returns one, initials on a tinted disc otherwise. The proxy
// (/api/messaging/avatar/[contactId]) always 200s — a blank pixel when there
// is no picture — so `onError` only fires on a genuine network failure; a
// blank pixel just shows through as (near) nothing, so we detect "tiny
// image" via naturalWidth and fall back too.
export function ChatAvatar({
  name,
  src,
  size = 40,
  className,
}: {
  name: string;
  src?: string | null;
  size?: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const showImg = src && !failed;

  return (
    <span
      className={cn(
        "relative flex flex-shrink-0 items-center justify-center overflow-hidden rounded-full bg-surface-subtle text-xs font-semibold text-secondary",
        className
      )}
      style={{ width: size, height: size, fontSize: Math.max(11, size * 0.32) }}
      aria-hidden
    >
      <span>{initials(name)}</span>
      {showImg && (
        // eslint-disable-next-line @next/next/no-img-element -- same-origin auth-cookie proxy route
        <img
          src={src}
          alt=""
          className="absolute inset-0 h-full w-full object-cover"
          onError={() => setFailed(true)}
          onLoad={(e) => {
            // The proxy's no-picture response is a 1x1 pixel — treat that as
            // "no avatar" so the initials show instead of a stretched dot.
            if ((e.currentTarget.naturalWidth || 0) <= 2) setFailed(true);
          }}
        />
      )}
    </span>
  );
}
