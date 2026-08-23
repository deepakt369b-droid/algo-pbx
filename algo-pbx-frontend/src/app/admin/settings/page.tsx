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

  const load = () => {
    fetch("/api/admin/settings")
      .then((r) => r.json())
      .then((data) => setSettings(data.settings ?? []));
  };

  useEffect(load, []);

  const save = async (key: string) => {
    const value = edits[key];
    if (value === undefined) return;
    setSavingKey(key);
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
        load();
      } else {
        const data = await res.json();
        alert(data.error ?? "Save failed");
      }
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
    } finally {
      setTestingSection(null);
    }
  };

  const sections = Array.from(new Set(settings.map((s) => s.section)));
  const testableSections = ["email", "whatsapp_openwa", "whatsapp_meta", "sms_dinstar", "firebase"];

  return (
    <div className="flex w-full flex-col items-center gap-6">
      <h1 className="text-xl font-semibold text-slate-100">Runtime Settings</h1>
      <p className="max-w-xl text-center text-xs text-slate-500">
        These take effect immediately — no restart needed. Secret values are never shown again once saved;
        leaving a field blank keeps the existing value.
      </p>

      {sections.map((section) => (
        <div key={section} className="glass-card w-full max-w-2xl p-6">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
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
            <p className={`mb-3 text-xs ${testResults[section].ok ? "text-green-400" : "text-red-400"}`}>
              {testResults[section].message}
            </p>
          )}

          <div className="flex flex-col gap-3">
            {settings
              .filter((s) => s.section === section)
              .map((s) => (
                <div key={s.key} className="flex flex-col gap-1">
                  <label className="text-xs font-medium text-slate-300">{s.label}</label>
                  {s.help && <p className="text-xs text-slate-500">{s.help}</p>}
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
                      className="rounded-lg bg-cyan px-3 py-2 text-xs font-medium text-background disabled:opacity-30"
                    >
                      Save
                    </button>
                  </div>
                  {s.hasValue && (
                    <p className="text-xs text-slate-600">
                      {s.secret ? `Configured (ending ${s.lastFour})` : "Configured"}
                      {s.updatedAt && ` — updated ${new Date(s.updatedAt).toLocaleString()}`}
                    </p>
                  )}
                </div>
              ))}
          </div>
        </div>
      ))}
    </div>
  );
}
