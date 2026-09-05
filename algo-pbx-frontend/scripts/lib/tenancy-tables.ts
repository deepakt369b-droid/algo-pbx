// Shared table list for the multi-tenant SaaS foundation's migration
// tooling (wave 1, 2026-09-04) — kept in exactly one place so
// migrate-backfill-tenancy.ts, snapshot-table-counts.ts, and
// rehearse-tenancy-migration.ts can never drift apart on which tables are
// "customer-owned" (get a tenantId) vs platform-global.
//
// Mirrors prisma/migrations/20260904100000_add_tenancy/migration.sql and
// step3_constrain.sql.template exactly.
export const TENANCY_TABLES: readonly string[] = [
  "User",
  "OtpChallenge",
  "TrustedDevice",
  "LoginAttempt",
  "Invite",
  "Extension",
  "Queue",
  "QueueMember",
  "CallDetailRecord",
  "DoNotCallEntry",
  "Recording",
  "AuditLog",
  "CallQualitySample",
  "EscalationTarget",
  "EscalationAttempt",
  "WaInstance",
  "Contact",
  "ContactTransferRequest",
  "ContactNote",
  "ContactTask",
  "CallDisposition",
  "Company",
  "PipelineStage",
  "Deal",
  "DealNote",
  "Activity",
  "Conversation",
  "ChatMessage",
  "Room",
  "SmsAccessRequest",
  "WebhookSubscription",
  "ApiKey",
  "AppSetting",
  "GatewayEvent",
  "GatewaySite",
  // Added with the recording-delivery feature (2026-09-06). Kept in sync
  // with src/lib/tenancy/scope-rules.ts's TENANT_SCOPED_MODELS — these two
  // lists must always name the same set. Note both tables were created
  // AFTER the tenancy backfill migration, so they start life with a NOT NULL
  // tenantId and need no backfill of their own.
  "RecordingStorageTarget",
  "RecordingDelivery",
];

// Platform-global tables (plan §1/§7) — never get a tenantId. Listed here
// only so the row-count snapshot can include them too (their counts should
// also be identical before/after — nothing should touch them).
export const PLATFORM_GLOBAL_TABLES: readonly string[] = [
  "PbxRuntimeFlag",
  "McpApproval",
  "InboundWebhookDelivery",
];
