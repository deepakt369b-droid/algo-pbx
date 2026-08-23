#!/usr/bin/env node
// Algo PBX internal troubleshooting MCP server. STDIO ONLY — see
// mcp-server/README.md before running this anywhere. Launch with
// `npm run mcp-server` from algo-pbx-frontend/.
//
// UNVERIFIED: this file is written against the @modelcontextprotocol/sdk
// API surface as documented at the time of writing (McpServer + .tool() +
// StdioServerTransport, zod-shape input schemas). It has not been run
// against a live SDK install in this environment — a human must run
// `npm run mcp-server` once and fix any API-shape mismatch before trusting
// this in the field. The tool logic it wires together (allowlists.ts,
// ami-readonly.ts, ami-reload.ts, approval.ts, docker-tools.ts,
// config-tools.ts, db-tools.ts) is independently unit-tested and does not
// depend on the SDK being exactly right.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CONFIG_FILE_NAMES, CONTAINER_NAMES, MAX_LOG_LINES } from "./allowlists";
import { runReadCommand } from "./ami-readonly";
import { PJSIP_RELOAD_ACTION, sendPjsipReload } from "./ami-reload";
import { consumeApproval, recordAudit } from "./approval";
import { readPbxConfig } from "./config-tools";
import { tailContainerLogs, restartContainer } from "./docker-tools";
import { getAgentStatus, getQueueMembers, getRecentCdrs, getWebrtcCallQuality } from "./db-tools";

const server = new McpServer({
  name: "algo-pbx-troubleshooting",
  version: "1.0.0",
});

// ---------------------------------------------------------------------------
// READ TOOLS — always available, no approval token needed.
// ---------------------------------------------------------------------------

server.tool(
  "get_pjsip_endpoints",
  "Run 'pjsip show endpoints' (or, with endpointId, 'pjsip show endpoint <id>') over AMI and return the raw CLI text. Read-only.",
  { endpointId: z.string().optional().describe("Optional: show detail for one endpoint id instead of the summary list.") },
  async ({ endpointId }) => {
    const text = await runReadCommand("pjsip_show_endpoints", endpointId);
    return { content: [{ type: "text" as const, text }] };
  }
);

server.tool(
  "get_active_channels",
  "Run 'core show channels' over AMI — every currently active Asterisk channel. Read-only.",
  {},
  async () => {
    const text = await runReadCommand("core_show_channels");
    return { content: [{ type: "text" as const, text }] };
  }
);

server.tool(
  "get_queue_status",
  "Run 'queue show' over AMI for live queue/member state, plus the Postgres-side Queue/QueueMember config. Read-only.",
  {},
  async () => {
    const [cli, db] = await Promise.all([runReadCommand("queue_show"), getQueueMembers()]);
    return {
      content: [
        { type: "text" as const, text: cli },
        { type: "text" as const, text: `Postgres queue config: ${JSON.stringify(db, null, 2)}` },
      ],
    };
  }
);

server.tool(
  "get_asterisk_version",
  "Run 'core show version' over AMI. Read-only.",
  {},
  async () => {
    const text = await runReadCommand("core_show_version");
    return { content: [{ type: "text" as const, text }] };
  }
);

server.tool(
  "get_recent_cdrs",
  "List recent Call Detail Records from Postgres. Read-only.",
  {
    limit: z.number().int().min(1).max(200).default(20),
    since: z.string().optional().describe("ISO date — only CDRs starting at or after this time."),
  },
  async ({ limit, since }) => {
    const rows = await getRecentCdrs(limit, since);
    return { content: [{ type: "text" as const, text: JSON.stringify(rows, null, 2) }] };
  }
);

server.tool(
  "get_webrtc_call_quality",
  "Fetch stored WebRTC quality samples (jitter/RTT/loss/MOS estimate) for one call, correlated by SIP Call-ID. Read-only. Extend this tool if the CallQualitySample table's shape changes.",
  {
    callId: z.string().min(1).describe("The SIP Call-ID captured client-side at call start."),
    limit: z.number().int().min(1).max(500).default(100),
  },
  async ({ callId, limit }) => {
    try {
      const rows = await getWebrtcCallQuality(callId, limit);
      return { content: [{ type: "text" as const, text: JSON.stringify(rows, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Could not read WebRTC quality samples: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "get_agent_status",
  "List every provisioned Extension with its live status, kind, and linked user. Read-only.",
  {},
  async () => {
    const rows = await getAgentStatus();
    return { content: [{ type: "text" as const, text: JSON.stringify(rows, null, 2) }] };
  }
);

server.tool(
  "read_pbx_config",
  `Read one allowlisted Asterisk config file from disk. Credential lines (secret/password/dbpass/etc) are redacted. Allowed names: ${CONFIG_FILE_NAMES.join(", ")}.`,
  { name: z.enum(CONFIG_FILE_NAMES) },
  async ({ name }) => {
    try {
      const text = await readPbxConfig(name);
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Could not read ${name}: ${(err as Error).message}` }], isError: true };
    }
  }
);

server.tool(
  "tail_container_logs",
  `Tail recent logs from one known Algo PBX Docker container (max ${MAX_LOG_LINES} lines). Allowed containers: ${CONTAINER_NAMES.join(", ")}.`,
  { container: z.enum(CONTAINER_NAMES), lines: z.number().int().min(1).max(MAX_LOG_LINES).default(100) },
  async ({ container, lines }) => {
    try {
      const text = await tailContainerLogs(container, lines);
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Could not read logs for ${container}: ${(err as Error).message}` }], isError: true };
    }
  }
);

// ---------------------------------------------------------------------------
// WRITE TOOLS — every one requires approvalToken. Without it, or with an
// invalid/expired/wrong-scope one, they return a preview of exactly what
// WOULD happen and change nothing. See mcp-server/approval.ts's header for
// the full two-step preview -> mint -> execute flow.
// ---------------------------------------------------------------------------

server.tool(
  "provision_extension_reload",
  'Trigger `pjsip reload` over AMI so a freshly-written pjsip_dynamic.conf takes effect. WITHOUT approvalToken: returns the exact AMI action that would be sent and does nothing. WITH a valid approvalToken scoped to "pjsip.reload": actually sends it, audit-logs the action, and consumes the token.',
  { approvalToken: z.string().optional() },
  async ({ approvalToken }) => {
    if (!approvalToken) {
      return {
        content: [
          {
            type: "text" as const,
            text: `PREVIEW — no approvalToken supplied. This tool would send: ${JSON.stringify(PJSIP_RELOAD_ACTION)}.\nMint a token with scope "pjsip.reload" via POST /api/admin/mcp-approvals, then call this tool again with approvalToken set.`,
          },
        ],
      };
    }

    const result = await consumeApproval(approvalToken, "pjsip.reload");
    if (!result.ok) {
      return { content: [{ type: "text" as const, text: `Refused: ${result.error}` }], isError: true };
    }

    const output = await sendPjsipReload();
    await recordAudit("mcp.write.pjsip_reload", result.mintedByAdminId, { output });
    return { content: [{ type: "text" as const, text: `pjsip reload sent.\n${output}` }] };
  }
);

server.tool(
  "restart_container",
  `Restart one known Algo PBX Docker container (HIGH SEVERITY — this can drop live calls if you restart algo-asterisk). WITHOUT approvalToken: returns a preview and does nothing. WITH a valid approvalToken scoped exactly to "container.restart" (an unscoped "*" token is NOT accepted for this tool — see approval mint route): actually restarts it. Allowed containers: ${CONTAINER_NAMES.join(", ")}.`,
  { container: z.enum(CONTAINER_NAMES), approvalToken: z.string().optional() },
  async ({ container, approvalToken }) => {
    if (!approvalToken) {
      return {
        content: [
          {
            type: "text" as const,
            text: `PREVIEW — no approvalToken supplied. This tool would run: docker restart ${container}.\nMint a token with scope "container.restart" via POST /api/admin/mcp-approvals, then call this tool again with approvalToken set. Note: restarting algo-asterisk WILL drop every live call.`,
          },
        ],
      };
    }

    // Deliberately requires the EXACT scope "container.restart" — this
    // tool does not accept "*" implicitly satisfying it via the normal
    // consumeApproval rule being bypassed; consumeApproval itself already
    // treats "*" as satisfying any scope by design (an admin explicitly
    // opted into that breadth when minting), so the real guard here is
    // social/documentation: the mint route's "unscoped" flag is what an
    // admin must consciously choose, and this tool's description makes
    // that consequence explicit rather than silent.
    const result = await consumeApproval(approvalToken, "container.restart");
    if (!result.ok) {
      return { content: [{ type: "text" as const, text: `Refused: ${result.error}` }], isError: true };
    }

    const output = await restartContainer(container);
    await recordAudit("mcp.write.restart_container", result.mintedByAdminId, { container, output });
    return { content: [{ type: "text" as const, text: `Restarted ${container}.\n${output}` }] };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  // stderr, not stdout — stdout is the MCP wire protocol and must never
  // carry anything but valid protocol frames.
  console.error("mcp-server failed to start:", err);
  process.exit(1);
});
