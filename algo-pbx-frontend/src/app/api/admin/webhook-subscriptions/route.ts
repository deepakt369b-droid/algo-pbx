import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireAdminSession } from "@/lib/auth-guard";

export const dynamic = "force-dynamic";

// GET/POST /api/admin/webhook-subscriptions — admin-managed CRM webhook
// destinations. Each row's `events` array is matched against emitEvent()'s
// first argument (src/lib/emit-event.ts) via Postgres array containment.
const CreateSchema = z.object({
  url: z.string().url(),
  events: z.array(z.string().min(1)).min(1),
  secret: z.string().min(16).optional(),
});

export async function POST(request: NextRequest) {
  const guard = await requireAdminSession();
  if ("response" in guard) return guard.response;

  const parsed = CreateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid payload", details: parsed.error.flatten() }, { status: 400 });

  const sub = await db.webhookSubscription.create({
    data: {
      url: parsed.data.url,
      events: parsed.data.events,
      secret: parsed.data.secret,
      createdById: guard.session.user.id,
    },
  });
  return NextResponse.json({ subscription: { ...sub, secret: undefined } }, { status: 201 });
}

export async function GET() {
  const guard = await requireAdminSession();
  if ("response" in guard) return guard.response;

  const subscriptions = await db.webhookSubscription.findMany({
    orderBy: { createdAt: "desc" },
    select: { id: true, url: true, events: true, active: true, createdById: true, createdAt: true },
  });
  return NextResponse.json({ subscriptions });
}
