import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { CountryCode } from "libphonenumber-js";
import { getCountries } from "libphonenumber-js";
import { db } from "@/lib/db";
import { requireStaffSession } from "@/lib/auth-guard";
import {
  buildContactImportPreview,
  buildRejectedRowsCsv,
  detectContactHeaders,
  parseTabularFile,
} from "@/lib/contact-import";

export const dynamic = "force-dynamic";

// POST /api/admin/contacts/bulk-import — Contact analogue of
// POST /api/dnc/bulk-import: same preview-before-commit shape (mode:
// "preview" parses+validates without touching the DB, mode: "commit"
// re-runs the same parse and actually inserts), same size/row caps and
// chunked-insert reasoning — see that route's header comment for why.
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_ROWS = 100_000;
const INSERT_BATCH_SIZE = 500;

const VALID_COUNTRIES = new Set(getCountries());

const BaseSchema = z.object({
  mode: z.enum(["preview", "commit"]),
  defaultCountry: z.string().refine((c) => VALID_COUNTRIES.has(c as CountryCode), "Unknown country code"),
  hasHeader: z.enum(["true", "false"]).optional(),
  phoneColumnIndex: z.string().regex(/^\d+$/).optional(),
  nameColumnIndex: z.string().regex(/^-?\d+$/).optional(), // "-1" means "no name column"
  ownerId: z.string().optional(), // applied to the whole batch, optional
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

  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    return NextResponse.json({ error: "Expected multipart/form-data." }, { status: 400 });
  }

  const form = await req.formData();
  const fields: Record<string, string> = {};
  for (const key of ["mode", "defaultCountry", "hasHeader", "phoneColumnIndex", "nameColumnIndex", "ownerId"]) {
    const v = form.get(key);
    if (typeof v === "string") fields[key] = v;
  }
  const parsed = BaseSchema.safeParse(fields);
  if (!parsed.success) {
    return NextResponse.json({ error: humanizeZodError(parsed.error) }, { status: 400 });
  }
  const { mode, ownerId } = parsed.data;
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

  const autoDetection = detectContactHeaders(grid, defaultCountry);
  const detection = {
    hasHeader: parsed.data.hasHeader !== undefined ? parsed.data.hasHeader === "true" : autoDetection.hasHeader,
    phoneColumnIndex: parsed.data.phoneColumnIndex !== undefined ? Number(parsed.data.phoneColumnIndex) : autoDetection.phoneColumnIndex,
    nameColumnIndex:
      parsed.data.nameColumnIndex !== undefined
        ? (Number(parsed.data.nameColumnIndex) === -1 ? null : Number(parsed.data.nameColumnIndex))
        : autoDetection.nameColumnIndex,
  };
  if (detection.phoneColumnIndex >= (grid[0]?.length ?? 0)) {
    return NextResponse.json({ error: "Selected phone column is out of range for this file." }, { status: 400 });
  }

  const preview = buildContactImportPreview(grid, detection, defaultCountry, MAX_ROWS);
  const columns = grid[0] ?? [];

  if (mode === "preview") {
    return NextResponse.json({
      hasHeader: detection.hasHeader,
      phoneColumnIndex: detection.phoneColumnIndex,
      nameColumnIndex: detection.nameColumnIndex,
      columns,
      sampleRows: grid.slice(detection.hasHeader ? 1 : 0, (detection.hasHeader ? 1 : 0) + 10),
      total: preview.total,
      validCount: preview.valid.length,
      invalidCount: preview.invalid.length,
      duplicatesInFile: preview.duplicatesInFile,
      invalidSample: preview.invalid.slice(0, 50),
    });
  }

  // mode === "commit" — insert in chunks. skipDuplicates covers both
  // cross-request re-imports and numbers already in the Contact table;
  // it's the authoritative duplicate check against the DB (see
  // contact-import.ts's comment on why buildContactImportPreview doesn't
  // try to duplicate it) — this is what satisfies #4's "never silently
  // create a second row with the same number" for the import path.
  let imported = 0;
  for (let i = 0; i < preview.valid.length; i += INSERT_BATCH_SIZE) {
    const chunk = preview.valid.slice(i, i + INSERT_BATCH_SIZE);
    const result = await db.contact.createMany({
      data: chunk.map((v) => ({
        numberE164: v.e164,
        displayName: v.name,
        ownerId: ownerId || undefined,
      })),
      skipDuplicates: true,
    });
    imported += result.count;
  }

  await db.auditLog.create({
    data: {
      action: "contact.bulk_import",
      actorId: guard.session.user.id,
      metadata: {
        imported,
        submittedValid: preview.valid.length,
        invalid: preview.invalid.length,
        duplicatesInFile: preview.duplicatesInFile,
        defaultCountry,
        ownerId: ownerId || null,
      },
    },
  });

  return NextResponse.json({
    imported,
    submittedValid: preview.valid.length,
    alreadyExisted: preview.valid.length - imported,
    invalidCount: preview.invalid.length,
    duplicatesInFile: preview.duplicatesInFile,
    rejectedCsv: preview.invalid.length ? buildRejectedRowsCsv(preview.invalid) : null,
  });
}
