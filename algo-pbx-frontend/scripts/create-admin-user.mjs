#!/usr/bin/env node
// There is no self-service signup — provisioning admin/supervisor/agent users
// is a deliberately staff-only action (see LLM.md §7 on auth). This script is
// the bootstrap path for the very first account, and a fallback for anyone
// without direct DB access afterward.
//
// Usage: node scripts/create-admin-user.mjs <email> <password> <name> [role]
//   role defaults to ADMIN. One of AGENT | SUPERVISOR | ADMIN.

import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const [, , email, password, name, role = "ADMIN"] = process.argv;

if (!email || !password || !name) {
  console.error("Usage: node scripts/create-admin-user.mjs <email> <password> <name> [role]");
  process.exit(1);
}
if (password.length < 8) {
  console.error("Password must be at least 8 characters (matches src/auth.ts's validation).");
  process.exit(1);
}
if (!["AGENT", "SUPERVISOR", "ADMIN"].includes(role)) {
  console.error("role must be one of AGENT, SUPERVISOR, ADMIN");
  process.exit(1);
}

const db = new PrismaClient();

const passwordHash = await bcrypt.hash(password, 12);
const user = await db.user.upsert({
  where: { email },
  create: { email, passwordHash, name, role },
  update: { passwordHash, name, role },
});

console.log(`Upserted user ${user.email} (${user.role}), id=${user.id}`);
await db.$disconnect();
