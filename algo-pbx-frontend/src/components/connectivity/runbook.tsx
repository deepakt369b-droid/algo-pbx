"use client";

import { useState } from "react";
import { createNamespaceCommand, createPreAuthKeyCommand, clientJoinCommand, listNodesCommand } from "@/lib/headscale-runbook";

// Static instructional content, always visible (not gated behind the
// wizard) — the task's own explicit requirement: the manual fallback must
// never be hidden behind the automated path. Two sections: the primary
// (OpenVPN, on-device click-path) and the fallback (Headscale, VPS-side
// CLI commands).
export function ConnectivityRunbook({ siteName }: { siteName: string }) {
  const [domain, setDomain] = useState("");

  return (
    <div className="flex flex-col gap-6">
      <div className="glass-card flex flex-col gap-3 p-6">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-secondary">Primary: OpenVPN (on the gateway)</h2>
        <ol className="list-decimal space-y-1 pl-5 text-xs text-secondary">
          <li>Log into the gateway&apos;s admin web UI (<code>https://&lt;gateway-ip&gt;</code>).</li>
          <li>
            <strong>Network Configuration → VPN Parameter.</strong>
          </li>
          <li>Choose the downloaded <code>.ovpn</code> file (from the wizard above, or generated ahead of time).</li>
          <li>
            Check <strong>OpenVPN Enable</strong>, then click <strong>Save</strong>.
          </li>
          <li>Confirm on this page: the site&apos;s row should show &quot;Up&quot; within about a minute once the tunnel handshakes.</li>
        </ol>
        <div className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs text-warning">
          <p className="mb-1 font-medium">If the tunnel doesn&apos;t come up</p>
          <p>
            This gateway&apos;s embedded OpenVPN client is old firmware — a handshake can fail silently against a
            server offering modern ciphers (this server is already configured for legacy compatibility, but if it
            still fails, the client is the only place to see why). On the same VPN Parameter page, click{" "}
            <strong>Download Log</strong> — it pulls the device&apos;s own OpenVPN client log, the only visibility
            into why the handshake was rejected.
          </p>
        </div>
      </div>

      <div className="glass-card flex flex-col gap-3 p-6">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-secondary">Fallback: Headscale</h2>
        <p className="text-xs text-tertiary">
          Use this if OpenVPN can&apos;t be made to work for a given site. Run these on the VPS&apos;s own shell.
        </p>

        <div className="rounded-lg border border-danger/30 bg-danger-subtle p-3 text-xs text-danger">
          <p className="mb-1 font-medium">Manual step required — no automation for this yet</p>
          <p>
            Before <code>vpn.&lt;your-domain&gt;</code> will resolve, add a grey-cloud (DNS-only, not proxied) A
            record for it in Cloudflare, pointing at this VPS&apos;s public IP. There is currently no
            automated way to create this record from the app — add it by hand in the Cloudflare dashboard.
          </p>
        </div>

        <label className="flex flex-col gap-1 text-xs text-tertiary">
          Your public domain (for the commands below)
          <input
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder="saharatechs.com"
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-primary outline-none focus:border-cyan"
          />
        </label>

        <ol className="list-decimal space-y-2 pl-5 text-xs text-secondary">
          <li>
            Create a namespace for this site:
            <pre className="mt-1 overflow-x-auto rounded bg-background p-2 text-tertiary">{createNamespaceCommand(siteName || "<site-name>")}</pre>
          </li>
          <li>
            Generate a pre-auth key:
            <pre className="mt-1 overflow-x-auto rounded bg-background p-2 text-tertiary">{createPreAuthKeyCommand(siteName || "<site-name>")}</pre>
          </li>
          <li>
            On the joining device, run (replace <code>&lt;key&gt;</code> with the key printed above):
            <pre className="mt-1 overflow-x-auto rounded bg-background p-2 text-tertiary">
              {clientJoinCommand(domain || "<your-domain>", "<key>")}
            </pre>
          </li>
          <li>
            Confirm it joined:
            <pre className="mt-1 overflow-x-auto rounded bg-background p-2 text-tertiary">{listNodesCommand()}</pre>
          </li>
        </ol>
      </div>
    </div>
  );
}
