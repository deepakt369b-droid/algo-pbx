import path from "node:path";

// Per-tenant on-disk layout for recordings.
//
// The layout moves from a flat `recordings/<uniqueId>.wav` to
// `recordings/<tenantId>/<uniqueId>.wav`. Two reasons, and the second is the
// one that made it urgent:
//
//   1. Per-tenant delivery needs a per-tenant directory to sync, and one flat
//      directory holding every customer's audio makes "ship this tenant's
//      recordings to their bucket" a filename-matching exercise.
//   2. A flat directory is one path-construction bug away from cross-tenant
//      exposure. With the tenant id in the path, serving the wrong customer's
//      audio requires getting the tenant id wrong too, not merely the file
//      name — defence in depth against the class of bug the traversal guard
//      already watches for.
//
// MIGRATION SAFETY: existing rows keep flat paths until the migration script
// moves them, so every reader must accept BOTH shapes. resolveRecordingPath()
// is that reader, and it is deliberately the only place the fallback lives.

export function recordingsRoot(): string {
  return path.resolve(process.env.RECORDINGS_DIR || "/recordings");
}

/** Where a NEW recording for this tenant belongs, relative to the root. */
export function tenantRelativePath(tenantId: string, fileName: string): string {
  return path.posix.join(tenantId, fileName);
}

export function tenantDir(tenantId: string): string {
  return path.join(recordingsRoot(), tenantId);
}

/** True when a stored filePath is already in the per-tenant layout. */
export function isTenantScopedPath(filePath: string): boolean {
  return filePath.includes("/") || filePath.includes("\\");
}

export interface ResolvedRecordingPath {
  absolute: string;
  layout: "tenant" | "legacy-flat";
}

/**
 * Resolves a stored `Recording.filePath` to an absolute path, accepting both
 * layouts, and refusing anything that escapes the recordings root.
 *
 * The traversal guard is not inherited from the existing route by accident —
 * it is re-asserted here because this function now joins MORE path segments
 * than the old code did (a tenant id as well as a filename), and every extra
 * segment is another place a `..` could enter.
 */
export function resolveRecordingPath(
  tenantId: string,
  filePath: string
): ResolvedRecordingPath | null {
  const root = recordingsRoot();

  const candidates: Array<{ p: string; layout: "tenant" | "legacy-flat" }> = isTenantScopedPath(filePath)
    ? [{ p: path.resolve(root, filePath), layout: "tenant" }]
    : [
        // Prefer the new location, so a migrated file is found first and the
        // legacy path stops being consulted once migration completes.
        { p: path.resolve(root, tenantId, filePath), layout: "tenant" },
        { p: path.resolve(root, filePath), layout: "legacy-flat" },
      ];

  for (const c of candidates) {
    if (c.p !== root && !c.p.startsWith(root + path.sep)) continue;
    return { absolute: c.p, layout: c.layout };
  }
  return null;
}

/** Object key / remote path for a delivered copy. Mirrors the local layout so
 * a customer browsing their bucket sees the same structure we do. */
export function remoteObjectKey(tenantId: string, filePath: string, prefix = ""): string {
  const name = isTenantScopedPath(filePath) ? filePath.split(/[\\/]/).pop()! : filePath;
  return path.posix.join(prefix.replace(/^\/+|\/+$/g, ""), tenantId, name).replace(/^\//, "");
}
