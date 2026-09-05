"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { validateTenantSlug } from "@/lib/tenant/slug";

// Create-tenant form.
//
// The slug is validated live with the SAME pure function the API uses, so the
// operator learns about a reserved word or a bad character while typing
// rather than on submit. It is worth being loud about: the slug becomes the
// subdomain, the certificate CN and the ccd filename simultaneously, and it
// is immutable afterwards — a typo here is a re-provision, not an edit.

export function NewTenantForm({ baseDomain, reserved }: { baseDomain: string; reserved: string[] }) {
  const router = useRouter();
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [plan, setPlan] = useState("standard");
  const [seats, setSeats] = useState(5);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const validation = slug ? validateTenantSlug(slug) : null;
  const slugError = validation && !validation.ok ? validation.error : null;
  const canSubmit = Boolean(slug && name && reason.trim() && !slugError && !submitting);

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/platform/tenants", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, name, plan, seats, reason: reason.trim() }),
      });
      const json = (await res.json().catch(() => null)) as
        | { tenant?: { id: string }; error?: string }
        | null;
      if (!res.ok || !json?.tenant) throw new Error(json?.error ?? "Could not create the tenant.");
      router.push(`/platform/provisioning/${json.tenant.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the tenant.");
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        <div className="space-y-1.5">
          <Label htmlFor="slug">Slug</Label>
          <Input
            id="slug"
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase())}
            placeholder="acme"
            autoComplete="off"
            spellCheck={false}
            data-testid="new-tenant-slug"
          />
          {slugError ? (
            <p className="text-[12px] text-danger" data-testid="slug-error">
              {slugError}
            </p>
          ) : (
            <p className="text-[11px] text-tertiary">
              Becomes <span className="font-mono">{slug || "<slug>"}.{baseDomain}</span>, the
              certificate CN <span className="font-mono">cust-{slug || "<slug>"}-gw-1</span>, and the
              ccd filename. Immutable once created.
            </p>
          )}
          <p className="text-[11px] text-tertiary">
            Reserved: {reserved.join(", ")}.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="tname">Customer name</Label>
          <Input
            id="tname"
            value={name}
            onChange={(e) => setName(e.target.value)}
            data-testid="new-tenant-name"
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="tplan">Plan</Label>
            <Input id="tplan" value={plan} onChange={(e) => setPlan(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tseats">Seats</Label>
            <Input
              id="tseats"
              type="number"
              min={1}
              value={seats}
              onChange={(e) => setSeats(Number(e.target.value))}
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="treason">
            Reason <span className="text-danger">*</span>
          </Label>
          <Textarea
            id="treason"
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Signed contract, onboarding ticket reference, …"
            data-testid="new-tenant-reason"
          />
        </div>

        {error && (
          <p role="alert" className="text-[13px] text-danger" data-testid="create-error">
            {error}
          </p>
        )}

        <div className="flex items-center gap-2">
          <Button disabled={!canSubmit} onClick={submit} data-testid="submit-new-tenant">
            {submitting ? "Creating…" : "Create tenant"}
          </Button>
          <p className="text-[11px] text-tertiary">
            The tenant starts on TRIAL. Compliance paperwork can be filed afterwards.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
