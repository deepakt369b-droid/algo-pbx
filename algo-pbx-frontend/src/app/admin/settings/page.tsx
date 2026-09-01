"use client";

import { useEffect, useState } from "react";

interface SettingRow {
  key: string;
  section: string;
  label: string;
  help?: string;
  secret: boolean;
  hasValue: boolean;
  value: string | null;
  lastFour: string | null;
  updatedAt: string | null;
}

const SECTION_LABELS: Record<string, string> = {
  email: "Email (Resend)",
  whatsapp_openwa: "WhatsApp — OpenWA",
  whatsapp_meta: "WhatsApp — Meta Cloud API (fallback)",
  sms_dinstar: "SMS — Dinstar UC2000",
  otp: "OTP Delivery",
  firebase: "Firebase (optional OTP channel)",
  crm: "CRM Webhooks",
  domain_tls: "Domain & TLS",
  retention: "Recording & Voicemail Retention",
};

// Admin-panel credential management (Workstream 4 of the runtime-config
// plan). Every field here resolves DB-first, env-fallback — see
// src/lib/settings/service.ts. Secret fields never receive their value
// back from the API (src/app/api/admin/settings/route.ts's GET never
// returns one); the UI shows a masked "configured, ending ****1234"
// state instead and treats a blank save as "leave unchanged", never
// "clear".
export default function SettingsPage() {
  const [settings, setSettings] = useState<SettingRow[]>([]);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; message: string }>>({});
  const [testingSection, setTestingSection] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<{ key: string; text: string } | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<{ ok: boolean; text: string } | null>(null);

  const [loadError, setLoadError] = useState<string | null>(null);

  const load = () => {
    fetch("/api/admin/settings")
      .then((r) => {
        if (!r.ok) throw new Error(r.status === 403 ? "Only an ADMIN can view runtime settings." : `Request failed (${r.status})`);
        return r.json();
      })
      .then((data) => {
        setSettings(data.settings ?? []);
        setLoadError(null);
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : "Could not load settings."));
  };

  useEffect(load, []);

  const save = async (key: string) => {
    const value = edits[key];
    if (value === undefined) return;
    setSavingKey(key);
    setSaveMessage(null);
    try {
      const res = await fetch("/api/admin/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value }),
      });
      if (res.ok) {
        setEdits((prev) => {
          const next = { ...prev };
          delete next[key];
          return next;
        });
        // A stale green "reachable" from before this edit is misleading
        // once the underlying value has changed — clear that section's
        // test result rather than leaving it looking current.
        const section = settings.find((s) => s.key === key)?.section;
        if (section) {
          setTestResults((prev) => {
            const next = { ...prev };
            delete next[section];
            return next;
          });
        }
        load();
      } else {
        const data = await res.json();
        setSaveMessage({ key, text: data.error ?? "Save failed" });
      }
    } catch (err) {
      setSaveMessage({ key, text: err instanceof Error ? err.message : "Network error." });
    } finally {
      setSavingKey(null);
    }
  };

  const testSection = async (section: string) => {
    setTestingSection(section);
    try {
      const res = await fetch("/api/admin/settings/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ section }),
      });
      const data = await res.json();
      setTestResults((prev) => ({ ...prev, [section]: { ok: res.ok && data.ok, message: data.message ?? data.error ?? "Unknown result" } }));
    } catch (err) {
      // A network-level failure (fetch itself throwing) previously left
      // testingSection cleared with no result line ever appearing — the
      // "Testing..." state just silently reverted with no feedback.
      setTestResults((prev) => ({
        ...prev,
        [section]: { ok: false, message: err instanceof Error ? err.message : "Network error." },
      }));
    } finally {
      setTestingSection(null);
    }
  };

  const applyDomain = async () => {
    setApplying(true);
    setApplyResult(null);
    try {
      const res = await fetch("/api/admin/settings/domain/apply", { method: "POST" });
      const data = await res.json();
      setApplyResult({ ok: res.ok && data.ok, text: data.message ?? data.error ?? "Unknown result" });
    } catch (err) {
      setApplyResult({ ok: false, text: err instanceof Error ? err.message : "Network error." });
    } finally {
      setApplying(false);
    }
  };

  const sections = Array.from(new Set(settings.map((s) => s.section)));
  const testableSections = ["email", "whatsapp_openwa", "whatsapp_meta", "sms_dinstar", "firebase", "domain_tls"];

  return (
    <div className="flex w-full flex-col items-center gap-6">
      <h1 className="text-xl font-semibold text-primary">Runtime Settings</h1>
      <p className="max-w-xl text-center text-xs text-tertiary">
        These take effect immediately — no restart needed. Secret values are never shown again once saved;
        leaving a field blank keeps the existing value.
      </p>

      {loadError && (
        <div className="w-full max-w-2xl rounded-lg border border-danger/40 bg-danger-subtle px-4 py-2 text-center text-xs text-danger">
          {loadError}
        </div>
      )}

      {sections.map((section) => (
        <div key={section} className="glass-card w-full max-w-2xl p-6">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-secondary">
              {SECTION_LABELS[section] ?? section}
            </h2>
            {testableSections.includes(section) && (
              <button
                onClick={() => testSection(section)}
                disabled={testingSection === section}
                className="rounded-lg border border-cyan px-3 py-1 text-xs text-cyan hover:bg-cyan/10 disabled:opacity-50"
              >
                {testingSection === section ? "Testing..." : "Test connection"}
              </button>
            )}
          </div>

          {testResults[section] && (
            <p className={`mb-3 text-xs ${testResults[section].ok ? "text-success" : "text-danger"}`}>
              {testResults[section].message}
            </p>
          )}

          <div className="flex flex-col gap-3">
            {settings
              .filter((s) => s.section === section)
              .map((s) => (
                <div key={s.key} className="flex flex-col gap-1">
                  <label className="text-xs font-medium text-secondary">{s.label}</label>
                  {s.help && <p className="text-xs text-tertiary">{s.help}</p>}
                  <div className="flex gap-2">
                    <input
                      type={s.secret ? "password" : "text"}
                      value={edits[s.key] ?? (s.secret ? "" : (s.value ?? ""))}
                      onChange={(e) => setEdits((prev) => ({ ...prev, [s.key]: e.target.value }))}
                      placeholder={s.secret && s.hasValue ? `configured, ending ${s.lastFour}` : "not configured"}
                      className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-cyan"
                    />
                    <button
                      onClick={() => save(s.key)}
                      disabled={edits[s.key] === undefined || savingKey === s.key}
                      className="rounded-lg bg-cyan px-3 py-2 text-xs font-medium text-accent-fg disabled:opacity-30"
                    >
                      Save
                    </button>
                  </div>
                  {s.hasValue && (
                    <p className="text-xs text-tertiary">
                      {s.secret ? `Configured (ending ${s.lastFour})` : "Configured"}
                      {s.updatedAt && ` — updated ${new Date(s.updatedAt).toLocaleString()}`}
                    </p>
                  )}
                  {saveMessage?.key === s.key && <p className="text-xs text-danger">{saveMessage.text}</p>}
                </div>
              ))}
          </div>

          {section === "domain_tls" && (
            <div className="mt-4 flex flex-col gap-2 border-t border-border pt-4">
              <p className="text-xs text-tertiary">
                Save the domain and token above first, then Connect — this writes the config Caddy actually reads
                and asks it to recreate itself with a fresh Let&apos;s Encrypt certificate. Save alone does not do this.
                First time setting this up?{" "}
                <a href="/admin/domain" className="text-cyan hover:underline">
                  Use the guided Connect Domain page
                </a>{" "}
                instead — same fields, plus live status and a Cloudflare token walkthrough.
              </p>
              <button
                onClick={applyDomain}
                disabled={applying}
                className="self-start rounded-lg bg-blue px-4 py-2 text-xs font-medium text-primary disabled:opacity-50"
              >
                {applying ? "Connecting…" : "Connect domain"}
              </button>
              {applyResult && (
                <p className={`text-xs ${applyResult.ok ? "text-success" : "text-danger"}`}>{applyResult.text}</p>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
