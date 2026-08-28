import { z } from "zod";

// Payload schema for POST /api/admin/dinstar/apply, factored out of the
// route handler so it's unit-testable like the rest of this codebase's
// dinstar-* logic (see dinstar-config.test.ts / dinstar-discovery.test.ts).
//
// sipPort's validator MUST match the DINSTAR_SIP_PORT entry in
// settings/schema.ts exactly (z.string().regex(/^\d{2,5}$/), default
// "5060") — that registry entry is what getSetting() falls back to, and a
// drift here would let the wizard accept a value the settings layer would
// later reject or silently override.
export const DinstarApplySchema = z.object({
  host: z.string().min(1).max(64),
  username: z.string().min(1),
  password: z.string().min(1),
  writeAsteriskConfig: z.boolean().default(false),
  sipPort: z.string().regex(/^\d{2,5}$/).default("5060"),
});

export type DinstarApplyPayload = z.infer<typeof DinstarApplySchema>;
