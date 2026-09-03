# Compliance notes

Data-protection notes for features whose data-handling choices need a
recorded rationale, rather than living only as a scattered code comment.
Not a legal document — a working log for the operator and future sessions.

## Dinstar gateway syslog events (`GatewayEvent`)

Added 2026-09-03 (Dinstar "Remote Server" / Diagnostic → Syslog feature —
see `handoff.md` and `LLM.md`'s build log for the full session).

**What's collected:** lines forwarded by the Dinstar UC2000 gateway's own
syslog client — GSM/SIP/VPN/system events (call attempts and rejections,
port registration state, SIM status, trunk reachability). The gateway's
message text **can contain phone numbers** (e.g. a rejected call attempt
naming the dialed or calling number), so this table is personal data under
UAE PDPL, the same category `CallDetailRecord` and `Recording` already are.

**Mitigation — retention:** `GatewayEvent` rows are pruned after
**30 days**, via `pruneGatewayEvents()` in
`POST /api/admin/maintenance/prune` (same cron/admin-triggered route
already used for `Recording`/voicemail retention). This is a fixed
constant, not an operator-adjustable `AppSetting` — see that function's
own comment for why. This is the stated data-minimization control for this
data: no other minimization is applied to the message content itself, so a
future session widening the syslog parser's taxonomy should not widen it
to capture more than what's operationally needed to classify and alert on
gateway events.

**Access:** staff-only (`requireStaffSession`) via the `/admin/system`
"Gateway events" panel and its `GET /api/admin/gateway-events` /
`GET /api/admin/gateway-alerts` routes — same access tier as every other
admin diagnostics surface (CDR, recordings, audit log).

**Ingestion:** `POST /api/gateway-events` accepts data only from
`scripts/gateway-syslog-listener.ts` over loopback, authenticated by a
shared bearer secret (`GATEWAY_INGEST_SECRET`) — no external or
cross-tenant write path exists.
