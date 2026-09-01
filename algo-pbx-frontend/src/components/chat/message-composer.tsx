"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

// POSTs to /api/messaging/conversations/[id]/messages (text) or
// /api/messaging/conversations/[id]/voice (a recorded voice note — WhatsApp
// only). The route resolves the correct provider from the conversation, so
// the composer needs no channel selector; it only uses `channel` to decide
// whether to offer the mic.

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onloadend = () => {
      const s = String(r.result);
      resolve(s.slice(s.indexOf(",") + 1));
    };
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function MessageComposer({
  conversationId,
  channel,
  onSent,
}: {
  conversationId: string;
  channel: "WHATSAPP" | "SMS";
  onSent?: () => void | Promise<void>;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Recording state
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [preview, setPreview] = useState<{ url: string; blob: Blob } | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const voiceSupported =
    channel === "WHATSAPP" &&
    typeof window !== "undefined" &&
    typeof window.MediaRecorder !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia;

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (preview) URL.revokeObjectURL(preview.url);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const send = async () => {
    if (!text.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`/api/messaging/conversations/${conversationId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok) {
        setText("");
        await onSent?.();
      } else {
        setError(data?.error ?? "Send failed");
      }
    } catch {
      setError("Send failed — network error.");
    } finally {
      setSending(false);
    }
  };

  const startRecording = async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/webm")
          ? "audio/webm"
          : "audio/ogg";
      const rec = new MediaRecorder(stream, { mimeType: mime });
      chunksRef.current = [];
      rec.ondataavailable = (e) => e.data.size > 0 && chunksRef.current.push(e.data);
      rec.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: rec.mimeType });
        setPreview({ url: URL.createObjectURL(blob), blob });
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      };
      rec.start();
      recorderRef.current = rec;
      setRecording(true);
      setElapsed(0);
      timerRef.current = setInterval(() => setElapsed((e) => e + 1), 1000);
    } catch {
      setError("Microphone access was denied.");
    }
  };

  const stopRecording = () => {
    recorderRef.current?.stop();
    if (timerRef.current) clearInterval(timerRef.current);
    setRecording(false);
  };

  const cancelRecording = () => {
    if (recording) stopRecording();
    if (preview) URL.revokeObjectURL(preview.url);
    setPreview(null);
    setElapsed(0);
  };

  const sendVoice = async () => {
    if (!preview || sending) return;
    setSending(true);
    setError(null);
    try {
      const base64 = await blobToBase64(preview.blob);
      const res = await fetch(`/api/messaging/conversations/${conversationId}/voice`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ base64, mimeType: preview.blob.type || "audio/webm", durationSec: elapsed }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok) {
        cancelRecording();
        await onSent?.();
      } else {
        setError(data?.error ?? "Voice send failed");
      }
    } catch {
      setError("Voice send failed — network error.");
    } finally {
      setSending(false);
    }
  };

  const label = `Message via ${channel === "WHATSAPP" ? "WhatsApp" : "SMS"}`;

  return (
    <div className="flex flex-shrink-0 flex-col gap-1 border-t bg-surface px-3 py-2.5">
      {preview ? (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={cancelRecording}
            aria-label="Discard recording"
            className="inline-flex h-9 w-9 items-center justify-center rounded-full text-danger hover:bg-surface-hover"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
          <audio src={preview.url} controls className="h-9 flex-1" />
          <button
            type="button"
            onClick={sendVoice}
            disabled={sending}
            aria-label="Send voice message"
            className="inline-flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-accent text-accent-fg disabled:opacity-40"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M3 11l18-8-8 18-2.5-7.5L3 11z" />
            </svg>
          </button>
        </div>
      ) : recording ? (
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-2 text-sm text-danger">
            <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-danger" />
            Recording {fmt(elapsed)}
          </span>
          <button
            type="button"
            onClick={cancelRecording}
            className="ml-auto rounded-[var(--radius-sm)] px-2 py-1 text-xs text-tertiary hover:bg-surface-hover"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={stopRecording}
            aria-label="Stop recording"
            className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-danger text-white"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <rect x="6" y="6" width="12" height="12" rx="2" />
            </svg>
          </button>
        </div>
      ) : (
        <div className="flex items-end gap-2">
          <textarea
            value={text}
            rows={1}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
            placeholder={`${label}…`}
            aria-label={label}
            className="max-h-32 min-h-[2.5rem] flex-1 resize-none rounded-[var(--radius-lg)] border bg-canvas px-3 py-2 text-sm text-primary outline-none placeholder:text-tertiary focus:border-accent"
          />
          {voiceSupported && !text.trim() && (
            <button
              type="button"
              onClick={startRecording}
              aria-label="Record a voice message"
              className="inline-flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full text-secondary hover:bg-surface-hover hover:text-primary"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path
                  d="M12 15a3 3 0 003-3V6a3 3 0 00-6 0v6a3 3 0 003 3z"
                  fill="currentColor"
                />
                <path
                  d="M19 12a7 7 0 01-14 0M12 19v3"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          )}
          <button
            onClick={send}
            disabled={sending || !text.trim()}
            aria-label="Send message"
            className={cn(
              "inline-flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-accent text-accent-fg transition-opacity",
              (sending || !text.trim()) && "opacity-40"
            )}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path
                d="M3 11l18-8-8 18-2.5-7.5L3 11z"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinejoin="round"
                fill="currentColor"
              />
            </svg>
          </button>
        </div>
      )}
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}
