# Algo PBX CRM connectivity

A generic, provider-neutral surface a CRM (or Zapier/n8n/Make/a first-party
integration) can build on. **No first-class HubSpot/Zoho/Salesforce/etc.
adapter exists yet** — this is deliberately the substrate one would be built
on top of after the trial run, per the plan's decision to ship the generic
layer first.

## Authentication

Every `/api/crm/**` route requires `Authorization: Bearer <api-key>`. Mint a
key as an admin:

```bash
curl -X POST https://<domain>/api/admin/api-keys \
  -H "Cookie: <admin session cookie>" \
  -H "Content-Type: application/json" \
  -d '{"label": "Zoho integration"}'
```

The raw key is returned **once**; only its hash is stored (see
`src/lib/api-key-auth.ts`). Revoke with `DELETE /api/admin/api-keys/[id]`.

## REST endpoints

- `GET /api/crm/contacts?q=<search>&limit=<n>` — search/list contacts.
- `POST /api/crm/contacts { number, displayName? }` — upsert a contact by
  E.164 number (server-normalizes via `src/lib/phone-normalize.ts`).
- `GET /api/crm/contacts/[id]/activity` — merged timeline of that contact's
  calls and chat messages, newest first. Sensitive (OTP-shaped) SMS bodies
  are never included, matching the agent-facing chat API's redaction rule.
- `POST /api/crm/click-to-call { extension, destination }` — originates a
  call from an agent's extension to `destination` via AMI.

All CRM routes are rate-limited per API key (`src/lib/rate-limit.ts`'s
`checkSimpleRateLimit`).

## Webhooks

Register a destination as an admin:

```bash
curl -X POST https://<domain>/api/admin/webhook-subscriptions \
  -H "Cookie: <admin session cookie>" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://your-crm.example.com/webhooks/algo-pbx", "events": ["call.ended"]}'
```

Each delivery is a `POST` with:

- `X-AlgoPBX-Event: <event name>`
- `X-AlgoPBX-Signature: <hex HMAC-SHA256 of the raw body>` — verify against
  either the subscription's own `secret` (if you set one at creation) or
  the deployment-wide `CRM_WEBHOOK_SECRET`.
- `X-AlgoPBX-Timestamp: <ISO 8601>`
- Retried up to 3 times (1s/4s/16s backoff) on non-2xx or network error,
  then dropped — this is not a durable queue.

### Event: `call.ended`

Fired from `POST /api/cdr` (the CDR ingestion route) once a call's CDR is
recorded.

```json
{
  "uniqueId": "1692800000.123",
  "callerNumber": "+971501234567",
  "destination": "1001",
  "direction": "inbound",
  "disposition": "ANSWERED",
  "durationSec": 142,
  "agentExtension": "1001"
}
```

### Event: `message.received` / `message.sent`

Fired from `src/lib/messaging/ingest.ts` (inbound WhatsApp/SMS, any
provider) and `POST /api/messaging/conversations/[id]/messages` (outbound).
Sensitive (OTP-shaped) SMS bodies are always omitted (`body: null`),
matching the agent-facing chat API's redaction rule.

```json
{ "conversationId": "...", "channel": "WHATSAPP", "fromE164": "+971501234567", "body": "...", "sensitive": false }
```
