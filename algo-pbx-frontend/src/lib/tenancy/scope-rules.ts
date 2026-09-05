// Pure decision logic for the Prisma `$extends` tenant-scoping client
// (`src/lib/db-tenant.ts`, wave 2a of the multi-tenant SaaS foundation —
// plan §2). Deliberately has ZERO Prisma/DB imports so it can be unit
// tested (`scope-rules.test.ts`) without a live Postgres connection, the
// same "extract the pure decision, keep the side effect thin" convention
// already used by `src/lib/recording-access.ts` and `src/lib/queue-status.ts`.
//
// db-tenant.ts's job is just: call `computeScopedArgs()` here to get the
// filtered args, then execute them inside a `SET LOCAL app.tenant_id`
// transaction. Every actual "which field gets filtered how" decision lives
// in this file.

// Prisma model names as they appear in `$extends`'s `model` parameter —
// PascalCase, exactly matching `model X { ... }` in schema.prisma. This
// list MUST stay in sync with `scripts/lib/tenancy-tables.ts`'s
// TENANCY_TABLES (that file lists the same ~34 models by their *table*
// name for the migration/backfill tooling; Prisma model names and table
// names are identical in this schema — no `@@map` is used anywhere — so
// the two lists are, and must stay, the same set of strings). Cross-
// reference: if you touch one, touch the other, and re-check
// `prisma/migrations/20260904100000_add_tenancy/migration.sql`'s ALTER
// TABLE list too.
export const TENANT_SCOPED_MODELS: readonly string[] = [
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
  "GatewayEvent",
  "GatewaySite",
  // Recording delivery (owner console). Both carry a tenantId and both are
  // listed here even though the platform console reads them through
  // unsafeGlobalDb: the moment a tenant-side page wants to show its own
  // delivery status, tenantDb() must scope it rather than throw "unknown
  // model" — and an unlisted model with a tenantId is exactly the shape a
  // future cross-tenant leak takes.
  "RecordingStorageTarget",
  "RecordingDelivery",
];

// AppSetting is the one model that does not fit the simple pattern (plan
// §7 / task instructions): its `tenantId` is NULLABLE. A row with
// `tenantId = null` is a PLATFORM DEFAULT; a row with a real `tenantId` is
// that tenant's override. A tenant-scoped client legitimately needs to see
// BOTH — the tenant's own overrides and the platform defaults it falls
// back to (`src/lib/settings/service.ts` already implements exactly that
// fallback chain: tenant row -> platform row -> env -> registry default).
//
// So the read-side rule here is "tenantId = mine OR tenantId IS NULL", not
// strict equality. Two things this file deliberately does NOT try to do:
//   1. Decide PRECEDENCE (tenant override beats platform default when both
//      exist for the same key) — that is `settings/service.ts`'s job. This
//      extension only prevents a tenant from seeing ANOTHER tenant's
//      override rows; it does not resolve "which of my visible rows wins",
//      because a plain Prisma `where` filter has no way to express "prefer
//      row A over row B for the same key" — that needs application code
//      that queries deliberately (tenant-specific key first, then the
//      null-tenant key) or post-processes a list, not a WHERE clause.
//   2. Rewrite unique-key lookups (`findUnique`/`update`/`delete` using
//      the `tenantId_key` compound unique). Those calls already spell out
//      exactly which row (tenant override or platform default, via
//      `tenantId: <id>` or `tenantId: null` in the compound key) the
//      caller wants — that IS the tenant-selection mechanism for a unique
//      lookup on this model, so rewriting it would fight the caller
//      instead of protecting them. NOT independently covered by
//      `scope-rules.test.ts`'s isolation guarantees for this reason; a
//      caller that constructs `tenantId_key` with an arbitrary tenantId
//      is trusted the same way `AppSetting`'s existing settings/service.ts
//      call sites are trusted today. Writes (create/update/upsert.create)
//      DO get tenantId forced to the caller's own tenant regardless (see
//      `computeScopedArgs` below) — a tenant-scoped client can create or
//      modify only ITS OWN override row, never a platform-default row and
//      never another tenant's.
export const NULLABLE_TENANT_MODELS: readonly string[] = ["AppSetting"];

// Explicitly platform-global (plan §1/§7, `migration.sql`'s trailing
// comment): no `tenantId` column exists on these tables at all. A
// tenant-scoped client calling into one of these is almost certainly a
// bug — the caller meant `unsafeGlobalDb` (or a future `platformDb()`),
// not a tenant scope — so `resolveModelScope` treats these the same as an
// unrecognized model: REJECT. We deliberately do NOT pass these through
// unscoped, even though "unscoped" would technically be correct for a
// truly global table, because silently special-casing "this one is fine
// actually" defeats the loud-failure discipline the whole extension exists
// for. If a legitimate need to reach one of these through a tenant-scoped
// client ever comes up, it should be a new, explicit, reviewed exception
// added here — not an implicit pass-through.
export const PLATFORM_GLOBAL_MODELS: readonly string[] = [
  "PbxRuntimeFlag",
  "McpApproval",
  "InboundWebhookDelivery",
];

export type ModelScope = "tenant" | "nullable-tenant" | "reject";

export function resolveModelScope(model: string): ModelScope {
  if (TENANT_SCOPED_MODELS.includes(model)) return "tenant";
  if (NULLABLE_TENANT_MODELS.includes(model)) return "nullable-tenant";
  return "reject";
}

// Operations whose `where` identifies (or is meant to identify) a single
// row via a unique key. Prisma has supported extra, non-unique filter
// fields alongside the unique identifier in these ops' `where` since 4.5's
// "extended where unique input" feature — `{ where: { id, tenantId } }` is
// valid and behaves as an AND, which is what lets us flat-merge here
// instead of needing an AND-wrapper the way the plain-filter ops below do.
const UNIQUE_WHERE_OPERATIONS = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "update",
  "delete",
]);

// Operations whose `where` is a general filter (may legally contain
// top-level `OR`/`NOT`), so merging tenantId in has to AND-wrap the whole
// thing rather than spread it alongside — a flat `{...where, tenantId}`
// would be silently defeated by a top-level `OR` in the caller's filter.
const FILTER_WHERE_OPERATIONS = new Set([
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "updateMany",
  "deleteMany",
  "count",
  "aggregate",
  "groupBy",
]);

function tenantWhereClause(tenantId: string, nullable: boolean): Record<string, unknown> {
  return nullable ? { OR: [{ tenantId }, { tenantId: null }] } : { tenantId };
}

function mergeUniqueWhere(
  where: Record<string, unknown> | undefined,
  tenantId: string,
  nullable: boolean
): Record<string, unknown> {
  // Nullable-tenant models (AppSetting): deliberately left untouched — see
  // NULLABLE_TENANT_MODELS's doc comment, point 2.
  if (nullable) return where ?? {};
  return { ...(where ?? {}), tenantId };
}

function mergeFilterWhere(
  where: Record<string, unknown> | undefined,
  tenantId: string,
  nullable: boolean
): Record<string, unknown> {
  return { AND: [where ?? {}, tenantWhereClause(tenantId, nullable)] };
}

function injectCreateData(data: unknown, tenantId: string): unknown {
  // A tenant-scoped client may only ever create rows that belong to it —
  // including on AppSetting, where this means it can create/overwrite its
  // OWN override row but can never create a `tenantId: null` platform
  // default. `tenantId` is force-set (overrides anything the caller
  // passed), same reasoning as `data.tenantId` injection in the plan.
  return { ...(data as Record<string, unknown>), tenantId };
}

export interface ScopedArgs {
  [key: string]: unknown;
}

/**
 * Pure transform: given a Prisma model/operation/args triple and the
 * calling tenant's id, return new args with tenancy enforced. Throws for
 * any model that isn't on the known tenant-scoped (or nullable-tenant)
 * list, and for any operation this file doesn't have an explicit rule
 * for — both are deliberate "fail loudly" cases per plan §2.
 */
export function computeScopedArgs(
  model: string,
  operation: string,
  args: ScopedArgs | undefined,
  tenantId: string
): ScopedArgs {
  if (!tenantId) {
    throw new Error(`tenantDb(): refusing to run ${model}.${operation} with an empty tenantId`);
  }

  const scope = resolveModelScope(model);
  if (scope === "reject") {
    throw new Error(
      `tenantDb(): model "${model}" is not on the tenant-scoped model list (src/lib/tenancy/scope-rules.ts). ` +
        `If this is a platform-global model, use unsafeGlobalDb directly; if it's a new customer-owned model, ` +
        `add it to TENANT_SCOPED_MODELS (and the migration/backfill lists it must stay in sync with) before ` +
        `wiring any route to it.`
    );
  }
  const nullable = scope === "nullable-tenant";
  const safeArgs = args ?? {};

  if (UNIQUE_WHERE_OPERATIONS.has(operation)) {
    return {
      ...safeArgs,
      where: mergeUniqueWhere(safeArgs.where as Record<string, unknown> | undefined, tenantId, nullable),
    };
  }

  if (FILTER_WHERE_OPERATIONS.has(operation)) {
    return {
      ...safeArgs,
      where: mergeFilterWhere(safeArgs.where as Record<string, unknown> | undefined, tenantId, nullable),
    };
  }

  if (operation === "create") {
    return { ...safeArgs, data: injectCreateData(safeArgs.data, tenantId) };
  }

  if (operation === "createMany" || operation === "createManyAndReturn") {
    const data = safeArgs.data;
    const rows = Array.isArray(data) ? data : [data];
    return { ...safeArgs, data: rows.map((row) => injectCreateData(row, tenantId)) };
  }

  if (operation === "upsert") {
    return {
      ...safeArgs,
      where: mergeUniqueWhere(safeArgs.where as Record<string, unknown> | undefined, tenantId, nullable),
      create: injectCreateData(safeArgs.create, tenantId),
      // `update` only ever touches non-identity fields on a row already
      // proven (by the scoped `where` above) to belong to this tenant —
      // no tenantId injection needed or wanted here.
      update: safeArgs.update,
    };
  }

  // Any operation without an explicit rule above (e.g. a future Prisma
  // client method this file hasn't been taught about) fails loudly rather
  // than passing through unscoped.
  throw new Error(
    `tenantDb(): operation "${operation}" on model "${model}" has no tenancy rule in ` +
      `src/lib/tenancy/scope-rules.ts — add one before using it from a tenant-scoped client.`
  );
}
