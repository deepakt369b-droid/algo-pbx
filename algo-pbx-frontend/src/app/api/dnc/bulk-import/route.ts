import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { CountryCode } from "libphonenumber-js";
import { getCountries } from "libphonenumber-js";
import type { Prisma } from "@prisma/client";
import { requireStaffSession } from "@/lib/auth-guard";
import {
  buildImportPreview,
  buildRejectedRowsCsv,
  detectHeaderAndPhoneColumn,
  parseTabularFile,
} from "@/lib/dnc-import";

export const dynamic = "force-dynamic";

// POST /api/dnc/bulk-import — CSV/XLSX upload (or pasted text) with a
// preview-before-commit step. `mode: "preview"` parses and validates
// without touching the DB; `mode: "commit"` re-runs the same parse (the
// client resends whatever it previewed, plus the confirmed header/column
// choice) and actually inserts. Two calls into the same stateless route
// beats holding server-side upload state between requests.
//
// Text length / row count were previously uncapped for the paste path —
// still true here, since a staff-authenticated caller (any SUPERVISOR/
// ADMIN, or a compromised admin session) could otherwise submit an
// arbitrarily large body. A real uploaded file is capped by size instead
// (parsing an oversized spreadsheet in-process is the expensive part, not
// just the row loop).
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_ROWS = 100_000;
const INSERT_BATCH_SIZE = 500;

const VALID_COUNTRIES = new Set(getCountries());

const BaseSchema = z.object({
  mode: z.enum(["preview", "commit"]),
  defaultCountry: z.string().refine((c) => VALID_COUNTRIES.has(c as CountryCode), "Unknown country code"),
  reason: z.string().max(500).optional(),
  hasHeader: z.enum(["true", "false"]).optional(),
  phoneColumnIndex: z.string().regex(/^\d+$/).optional(),
});

function humanizeZodError(error: z.ZodError): string {
  const first = error.issues[0];
  if (!first) return "Invalid request.";
  const path = first.path.length ? `${first.path.join(".")}: ` : "";
  return `${path}${first.message}`;
}

export async function POST(req: NextRequest) {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;
  const { session, db } = guard;

  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    return NextResponse.json({ error: "Expected multipart/form-data." }, { status: 400 });
  }

  const form = await req.formData();
  const fields: Record<string, string> = {};
  for (const key of ["mode", "defaultCountry", "reason", "hasHeader", "phoneColumnIndex"]) {
    const v = form.get(key);
    if (typeof v === "string") fields[key] = v;
  }
  const parsed = BaseSchema.safeParse(fields);
  if (!parsed.success) {
    return NextResponse.json({ error: humanizeZodError(parsed.error) }, { status: 400 });
  }
  const { mode, reason } = parsed.data;
  const defaultCountry = parsed.data.defaultCountry as CountryCode;

  const file = form.get("file");
  const text = form.get("text");

  let grid: string[][];
  if (file instanceof File) {
    if (file.size > MAX_FILE_BYTES) {
      return NextResponse.json({ error: `File is too large (max ${MAX_FILE_BYTES / (1024 * 1024)}MB).` }, { status: 400 });
    }
    const buf = await file.arrayBuffer();
    try {
      grid = parseTabularFile(buf, file.name);
    } catch {
      return NextResponse.json({ error: "Could not parse the file. Is it a valid CSV or XLSX?" }, { status: 400 });
    }
  } else if (typeof text === "string" && text.trim()) {
    if (Buffer.byteLength(text, "utf-8") > MAX_TEXT_BYTES) {
      return NextResponse.json({ error: `Pasted text is too large (max ${MAX_TEXT_BYTES / (1024 * 1024)}MB).` }, { status: 400 });
    }
    grid = parseTabularFile(text, "pasted.txt");
  } else {
    return NextResponse.json({ error: "Provide either a file upload or pasted text." }, { status: 400 });
  }

  if (grid.length === 0) {
    return NextResponse.json({ error: "No rows found in the upload." }, { status: 400 });
  }

  const autoDetection = detectHeaderAndPhoneColumn(grid, defaultCountry);
  const detection = {
    hasHeader: parsed.data.hasHeader !== undefined ? parsed.data.hasHeader === "true" : autoDetection.hasHeader,
    phoneColumnIndex: parsed.data.phoneColumnIndex !== undefined ? Number(parsed.data.phoneColumnIndex) : autoDetection.phoneColumnIndex,
  };
  if (detection.phoneColumnIndex >= (grid[0]?.length ?? 0)) {
    return NextResponse.json({ error: "Selected phone column is out of range for this file." }, { status: 400 });
  }

  const preview = buildImportPreview(grid, detection, defaultCountry, MAX_ROWS);
  const columns = grid[0] ?? [];

  if (mode === "preview") {
    return NextResponse.json({
      hasHeader: detection.hasHeader,
      phoneColumnIndex: detection.phoneColumnIndex,
      columns,
      sampleRows: grid.slice(detection.hasHeader ? 1 : 0, (detection.hasHeader ? 1 : 0) + 10),
      total: preview.total,
      validCount: preview.valid.length,
      invalidCount: preview.invalid.length,
      duplicatesInFile: preview.duplicatesInFile,
      invalidSample: preview.invalid.slice(0, 50),
    });
  }

  // mode === "commit" — insert in chunks rather than one upsert per row,
  // which previously timed out on any real-sized list. skipDuplicates
  // covers both cross-request re-imports and numbers already on the list;
  // it's also the authoritative duplicate check (see dnc-import.ts's
  // comment on why buildImportPreview() doesn't try to duplicate it).
  let imported = 0;
  for (let i = 0; i < preview.valid.length; i += INSERT_BATCH_SIZE) {
    const chunk = preview.valid.slice(i, i + INSERT_BATCH_SIZE);
    const result = await db.doNotCallEntry.createMany({
      data: chunk.map((v) => ({
        numberE164: v.e164,
        reason,
        source: "bulk_import",
        addedById: session.user.id,
      })) as unknown as Prisma.DoNotCallEntryCreateManyInput[],
      skipDuplicates: true,
    });
    imported += result.count;
  }

  await db.auditLog.create({
    data: {
      action: "dnc.bulk_import",
      actorId: session.user.id,
      metadata: {
        imported,
        submittedValid: preview.valid.length,
        invalid: preview.invalid.length,
        duplicatesInFile: preview.duplicatesInFile,
        defaultCountry,
      },
    } as unknown as Prisma.AuditLogUncheckedCreateInput,
  });

  return NextResponse.json({
    imported,
    submittedValid: preview.valid.length,
    alreadyOnList: preview.valid.length - imported,
    invalidCount: preview.invalid.length,
    duplicatesInFile: preview.duplicatesInFile,
    rejectedCsv: preview.invalid.length ? buildRejectedRowsCsv(preview.invalid) : null,
  });
}
