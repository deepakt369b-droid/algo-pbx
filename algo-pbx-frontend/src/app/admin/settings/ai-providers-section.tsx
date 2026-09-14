"use client";

import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "@/lib/client/api";
import type { AiModelInfo, AiProviderKind } from "@/lib/ai/types";

// AI providers section for /admin/settings (W7 task 3). Consumes the
// already-built GET/POST /api/admin/ai/providers, POST .../[id]/refresh,
// DELETE .../[id] routes (src/app/api/admin/ai/providers/**) — nothing
// here re-implements the provider adapters or their validation, it only
// calls those routes. apiKeyCipher is never returned by any of them, so
// there is nothing to accidentally render here.
const PROVIDER_KINDS: AiProviderKind[] = [
  "openai",
  "anthropic",
  "gemini",
  "groq",
  "deepgram",
  "elevenlabs",
  "cartesia",
  "sarvam",
  "assemblyai",
  "azure",
  "ultravox",
  "openai_compatible",
  "retell",
  "vapi",
];

interface Credential {
  id: string;
  provider: AiProviderKind;
  label: string;
  region: string | null;
  baseUrl: string | null;
  cachedModels: AiModelInfo[] | null;
  fetchedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function AiProvidersSection() {
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [provider, setProvider] = useState<AiProviderKind>("openai");
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [region, setRegion] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; kind: "ok" | "error" } | null>(null);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);

  const load = async () => {
    try {
      const data = await apiFetch<{ credentials: Credential[] }>("/api/admin/ai/providers");
      setCredentials(data.credentials ?? []);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Could not load AI provider credentials.");
    }
  };

  useEffect(() => {
    load();
  }, []);

  const create = async () => {
    setSaving(true);
    setMessage(null);
    try {
      await apiFetch("/api/admin/ai/providers", {
        method: "POST",
        body: {
          provider,
          label,
          apiKey,
          region: region.trim() || undefined,
          baseUrl: baseUrl.trim() || undefined,
        },
      });
      setLabel("");
      setApiKey("");
      setRegion("");
      setBaseUrl("");
      setMessage({ text: "Provider credential saved.", kind: "ok" });
      load();
    } catch (err) {
      setMessage({ text: err instanceof ApiError ? err.message : "Could not save this credential.", kind: "error" });
    } finally {
      setSaving(false);
    }
  };

  const refresh = async (id: string) => {
    setRefreshingId(id);
    setMessage(null);
    try {
      await apiFetch(`/api/admin/ai/providers/${id}/refresh`, { method: "POST" });
      load();
    } catch (err) {
      setMessage({ text: err instanceof ApiError ? err.message : "Could not refresh models.", kind: "error" });
    } finally {
      setRefreshingId(null);
    }
  };

  const remove = async (id: string, credLabel: string) => {
    if (!confirm(`Delete the "${credLabel}" provider credential? Any AI agent leg using it will stop working.`)) return;
    try {
      await apiFetch(`/api/admin/ai/providers/${id}`, { method: "DELETE" });
      load();
    } catch (err) {
      setMessage({ text: err instanceof ApiError ? err.message : "Could not delete this credential.", kind: "error" });
    }
  };

  return (
    <div className="glass-card w-full max-w-2xl p-6">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-secondary">AI Providers</h2>
      <p className="mb-3 text-xs text-tertiary">
        API keys used by AI agents (see <span className="text-secondary">/admin/ai-agents</span>). Keys are
        validated against the provider before saving and never shown again once saved.
      </p>

      {loadError && (
        <div className="mb-3 rounded-lg border border-danger/40 bg-danger-subtle px-4 py-2 text-center text-xs text-danger">
          {loadError}
        </div>
      )}

      <div className="mb-4 flex flex-col gap-2 rounded-lg border border-border bg-background/40 p-3">
        <div className="flex flex-wrap gap-2">
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value as AiProviderKind)}
            className="rounded-lg border border-border bg-background px-2 py-2 text-sm outline-none focus:border-cyan"
          >
            {PROVIDER_KINDS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Label, e.g. Production OpenAI key"
            className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-cyan"
          />
        </div>
        <input
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          type="password"
          placeholder="API key"
          className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-cyan"
        />
        <div className="flex flex-wrap gap-2">
          <input
            value={region}
            onChange={(e) => setRegion(e.target.value)}
            placeholder="Region (optional, e.g. asia-south1)"
            className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-cyan"
          />
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="Base URL (optional, for OpenAI-compatible)"
            className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-cyan"
          />
        </div>
        <button
          onClick={create}
          disabled={saving || !label.trim() || !apiKey.trim()}
          className="self-start rounded-lg bg-cyan px-4 py-2 text-xs font-medium text-accent-fg disabled:opacity-50"
        >
          {saving ? "Validating & saving…" : "Add provider"}
        </button>
        {message && (
          <p className={`text-xs ${message.kind === "error" ? "text-danger" : "text-tertiary"}`}>{message.text}</p>
        )}
      </div>

      {credentials.length === 0 ? (
        <p className="text-tertiary">No AI provider credentials configured yet.</p>
      ) : (
        <ul className="flex flex-col gap-2 text-sm text-primary">
          {credentials.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-3 border-t border-border pt-2 first:border-0 first:pt-0">
              <div>
                <p>
                  {c.label} <span className="text-tertiary">({c.provider})</span>
                </p>
                <p className="text-xs text-tertiary">
                  {c.region ? `${c.region} · ` : ""}
                  {c.cachedModels?.length ?? 0} model{(c.cachedModels?.length ?? 0) === 1 ? "" : "s"}
                  {c.fetchedAt ? ` · fetched ${new Date(c.fetchedAt).toLocaleString()}` : ""}
                </p>
              </div>
              <div className="flex gap-2 text-xs">
                <button
                  onClick={() => refresh(c.id)}
                  disabled={refreshingId === c.id}
                  className="text-cyan hover:underline disabled:opacity-50"
                >
                  {refreshingId === c.id ? "Refreshing…" : "Refresh models"}
                </button>
                <button onClick={() => remove(c.id, c.label)} className="text-danger hover:text-danger">
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
