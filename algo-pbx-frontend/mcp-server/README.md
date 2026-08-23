# Algo PBX troubleshooting MCP server

Internal, stdio-only MCP server for live-troubleshooting the PBX during the
trial run and afterward. **Never wrap this in a network listener** — it is
designed to be launched on the deployment VM (directly, or over an SSH
tunnel from an operator's machine) by a human who is already trusted to be
there, not exposed as a service.

## Launching

```bash
cd algo-pbx-frontend
npm run mcp-server
```

This runs `tsx mcp-server/index.ts`, which speaks MCP over stdio. Point
whatever LLM client you're using (Claude Desktop, Claude Code, etc.) at
this command — consult your client's docs for how it registers a stdio MCP
server (typically a `command`/`args` entry in its own config pointing at
`npm --prefix <path-to-algo-pbx-frontend> run mcp-server`, or `node` +
`tsx` directly).

Requires the same environment variables the web app uses for AMI and the
database: `AMI_HOST`, `AMI_PORT`, `AMI_USERNAME`, `AMI_SECRET`,
`DATABASE_URL`. Run it from a shell that has `.env` sourced, or export
those explicitly.

## What it can do without any approval

Everything under "READ TOOLS" in `index.ts`: PJSIP endpoint state, active
channels, queue status, Asterisk version, recent CDRs, stored WebRTC
quality samples, agent/extension status, allowlisted PBX config files
(credentials redacted), and recent container log tails. None of these
mutate anything.

## What requires an approval token, and why

Two tools — `provision_extension_reload` (AMI `pjsip reload`) and
`restart_container` (`docker restart <container>`) — are gated. Calling
either **without** `approvalToken` returns a preview of exactly what would
happen and changes nothing.

To actually execute one:

1. An admin, from the web app (or `curl` on the VM), mints a token:
   ```bash
   curl -X POST https://<domain>/api/admin/mcp-approvals \
     -H "Cookie: <admin session cookie>" \
     -H "Content-Type: application/json" \
     -d '{"scope": "pjsip.reload", "ttlMinutes": 10}'
   ```
   Response includes the raw token **once** — it is never stored or
   retrievable again (only its hash is kept, same pattern as this app's
   agent-invite tokens).
2. Hand that token to whoever is operating the MCP server for that one
   action.
3. Call the tool again with `approvalToken` set to that value. The server
   validates it (right scope, not expired, not already used), performs the
   write, writes an `AuditLog` row attributed to the admin who minted the
   token, and **consumes the token immediately** — it cannot be reused.

`restart_container` in particular should be scoped exactly to
`"container.restart"` when minted, not left as the default
`"pjsip.reload"` scope — the mint route lets an admin choose. An unscoped
`"*"` token satisfies any tool but must be explicitly opted into
(`unscoped: true` in the mint request) — it is never the default, so a
hurried admin can't accidentally hand out a token that authorizes
everything.

## Hard limits (do not weaken these)

- No tool accepts an arbitrary shell command.
- No tool sends a raw, caller-supplied AMI action string — `get_pjsip_endpoints`
  et al. only ever select from a fixed table of pre-built AMI `Command`
  strings (`mcp-server/ami-readonly.ts`), the same way the app-layer AMI
  CRLF-injection bug (fixed separately in `src/lib/ami-client.ts`) is
  prevented here at the design level, not just with an escape function.
- `read_pbx_config` takes an enum key, never a path — see
  `mcp-server/allowlists.ts`'s `CONFIG_FILE_NAMES`.
- `tail_container_logs` / `restart_container` take an enum of known
  `docker-compose.yml` service names, executed via `execFile` with an argv
  array (never a shell string), never an operator-supplied container name.

## A human must verify before trusting this in the field

This was written against the documented `@modelcontextprotocol/sdk` shape
(`McpServer`, `.tool(name, description, zodShape, handler)`,
`StdioServerTransport`) without being able to run it in this environment.
Run `npm run mcp-server` once, connect a real MCP client, and confirm the
tool list loads and at least one read tool (`get_asterisk_version` is the
cheapest) round-trips correctly before relying on this during the trial.
