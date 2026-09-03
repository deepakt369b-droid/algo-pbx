"use client";

interface GatewaySite {
  id: string;
  name: string;
  gatewayLanIp: string;
  tunnelIp: string | null;
  transport: "TAILSCALE" | "OPENVPN" | "HEADSCALE";
  status: "UNKNOWN" | "UP" | "DEGRADED" | "DOWN";
  lastHandshakeAt: string | null;
  lastReachableAt: string | null;
}

// Green iff status is UP *and* the last handshake was within 3 minutes —
// matches the plan's stated freshness threshold. A stale "UP" row (the
// poller hasn't checked in) reads as DEGRADED, not a false-positive green.
const HANDSHAKE_FRESH_MS = 3 * 60 * 1000;

function effectiveDot(site: GatewaySite): { color: string; label: string } {
  if (site.status === "DOWN") return { color: "bg-danger", label: "Down" };
  if (site.status === "UNKNOWN") return { color: "bg-surface-hover", label: "Unknown" };
  const fresh = site.lastHandshakeAt && Date.now() - new Date(site.lastHandshakeAt).getTime() < HANDSHAKE_FRESH_MS;
  if (site.status === "UP" && fresh) return { color: "bg-success", label: "Up" };
  return { color: "bg-warning", label: "Degraded" };
}

const TRANSPORT_LABEL: Record<GatewaySite["transport"], string> = {
  TAILSCALE: "Tailscale (legacy)",
  OPENVPN: "OpenVPN (primary)",
  HEADSCALE: "Headscale (fallback)",
};

export function SiteTable({
  sites,
  onEdit,
  onDelete,
}: {
  sites: GatewaySite[];
  onEdit: (site: GatewaySite) => void;
  onDelete: (site: GatewaySite) => void;
}) {
  if (sites.length === 0) {
    return <p className="text-xs text-tertiary">No sites yet — add one below to start the OpenVPN cutover.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead>
          <tr className="border-b border-border text-tertiary">
            <th className="py-2 pr-3 font-medium">Site</th>
            <th className="py-2 pr-3 font-medium">Gateway LAN IP</th>
            <th className="py-2 pr-3 font-medium">Tunnel IP</th>
            <th className="py-2 pr-3 font-medium">Transport</th>
            <th className="py-2 pr-3 font-medium">Status</th>
            <th className="py-2 pr-3 font-medium">Last handshake</th>
            <th className="py-2 font-medium">Actions</th>
          </tr>
        </thead>
        <tbody>
          {sites.map((site) => {
            const dot = effectiveDot(site);
            return (
              <tr key={site.id} className="border-b border-border/50 text-primary">
                <td className="py-2 pr-3 font-medium">{site.name}</td>
                <td className="py-2 pr-3 text-secondary">{site.gatewayLanIp}</td>
                <td className="py-2 pr-3 text-secondary">{site.tunnelIp ?? "—"}</td>
                <td className="py-2 pr-3 text-secondary">{TRANSPORT_LABEL[site.transport]}</td>
                <td className="py-2 pr-3">
                  <span className="inline-flex items-center gap-1.5">
                    <span className={`h-1.5 w-1.5 rounded-full ${dot.color}`} />
                    {dot.label}
                  </span>
                </td>
                <td className="py-2 pr-3 text-tertiary">
                  {site.lastHandshakeAt ? new Date(site.lastHandshakeAt).toLocaleString() : "never"}
                </td>
                <td className="py-2">
                  <button onClick={() => onEdit(site)} className="mr-3 text-cyan hover:underline">
                    Edit
                  </button>
                  <button onClick={() => onDelete(site)} className="text-danger hover:underline">
                    Remove
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export type { GatewaySite };
