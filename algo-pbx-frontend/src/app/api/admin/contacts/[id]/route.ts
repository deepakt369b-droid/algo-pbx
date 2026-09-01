import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import type { CountryCode } from "libphonenumber-js";
import { db } from "@/lib/db";
import { requireStaffSession } from "@/lib/auth-guard";
import { normalizeToE164 } from "@/lib/phone-normalize";

export const dynamic = "force-dynamic";

// PATCH/DELETE /api/admin/contacts/[id] — edit (including reassign, which
// is just a PATCH carrying only ownerId) or remove a single Contact. Same
// requireStaffSession gate as the collection route (see its header
// comment) — only ADMIN/SUPERVISOR sessions ever reach this page at all.
//
// All fields optional/partial: the admin/contacts page reuses this one
// schema for both the full edit form and the one-field "Reassign" quick
// action, so every field must be independently omittable.
const UpdateContactSchema = z.object({
  number: z.string().min(3).optional(),
  country: z.string().length(2).optional(),
  displayName: z.string().trim().min(1).max(200).optional(),
  email: z.string().trim().email().max(200).nullable().optional().or(z.literal("")),
  company: z.string().trim().max(200).nullable().optional(),
  companyId: z.string().nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(50)).max(50).optional(),
  ownerId: z.string().nullable().optional(),
});

function humanizeZodError(error: z.ZodError): string {
  const first = error.issues[0];
  if (!first) return "Invalid request.";
  const path = first.path.length ? `${first.path.join(".")}: ` : "";
  return `${path}${first.message}`;
}

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;

  const parsed = UpdateContactSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: humanizeZodError(parsed.error) }, { status: 400 });
  }

  const data: Prisma.ContactUpdateInput = {};
  if (parsed.data.displayName !== undefined) data.displayName = parsed.data.displayName;
  if (parsed.data.email !== undefined) data.email = parsed.data.email || null;
  if (parsed.data.company !== undefined) data.company = parsed.data.company;
  if (parsed.data.companyId !== undefined) {
    data.companyRel = parsed.data.companyId
      ? { connect: { id: parsed.data.companyId } }
      : { disconnect: true };
  }
  if (parsed.data.tags !== undefined) data.tags = parsed.data.tags;
  if (parsed.data.ownerId !== undefined) {
    data.owner = parsed.data.ownerId ? { connect: { id: parsed.data.ownerId } } : { disconnect: true };
  }

  if (parsed.data.number !== undefined) {
    const country = (parsed.data.country as CountryCode | undefined) ?? undefined;
    const numberE164 = normalizeToE164(parsed.data.number, country);
    if (!numberE164) {
      return NextResponse.json({ error: `"${parsed.data.number}" doesn't look like a valid phone number.` }, { status: 400 });
    }
    data.numberE164 = numberE164;
  }

  try {
    const contact = await db.contact.update({ where: { id: params.id }, data });
    return NextResponse.json({ contact });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      if (err.code === "P2002") {
        return NextResponse.json({ error: "Another contact already uses this number." }, { status: 409 });
      }
      if (err.code === "P2025") {
        return NextResponse.json({ error: "Contact not found" }, { status: 404 });
      }
    }
    throw err;
  }
}

// Contact.id is a required, non-cascading FK on Conversation
// (prisma/schema.prisma's `contact Contact @relation(fields: [contactId],
// references: [id])` has no onDelete, so Prisma's default is Restrict) —
// unlike DELETE /api/dnc/[id]'s unconditional hard delete, deleting a
// Contact that still has message history would throw at the DB level. Check
// first and return a clear 409 instead of letting that throw become an
// unstyled 500, or silently swallowing it into a false "ok: true".
export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;

  const conversationCount = await db.conversation.count({ where: { contactId: params.id } });
  if (conversationCount > 0) {
    return NextResponse.json(
      { error: "This contact has message history and can't be deleted. Clear its conversations first." },
      { status: 409 }
    );
  }

  const deleted = await db.contact.delete({ where: { id: params.id } }).catch(() => null);
  if (!deleted) return NextResponse.json({ error: "Contact not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
