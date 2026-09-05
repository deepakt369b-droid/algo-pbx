# E2E (Playwright)

Playwright is the **only** UI verification in this repo — vitest runs in a
node environment with no jsdom, so React components are not unit-tested.

## Run

```bash
# against an already-running server (default http://localhost:3000)
E2E_ADMIN_EMAIL=... E2E_ADMIN_PASSWORD=... \
E2E_AGENT_EMAIL=... E2E_AGENT_PASSWORD=... \
npm run test:e2e

# let Playwright boot the server too
E2E_WEBSERVER=1 npm run test:e2e
```

Without creds the `setup` project skips and only `*.anon.spec.ts` run.

## Layout

| file pattern | project | storageState |
|---|---|---|
| `auth.setup.ts` | setup | writes `.auth/{admin,agent}.json` |
| `*.admin.spec.ts` | admin (Desktop Chrome) | `.auth/admin.json` |
| `*.agent.spec.ts` | agent (Desktop Chrome) | `.auth/agent.json` |
| `*.mobile.spec.ts` | mobile (iPhone 13) | `.auth/agent.json` |
| `*.anon.spec.ts` | anon | none |

`.auth/` and `test-results/` / `playwright-report/` are git-ignored.

## Platform (owner console) suite

Project `platform`, matching `*.platform.spec.ts`, using `.auth/platform.json`.
It is a separate project rather than another role because the platform plane
has its own session cookie (`algopbx-platform-session`) — a tenant storage
state carries the wrong cookie entirely, not merely the wrong role.

### Environment

```
E2E_PLATFORM_EMAIL
E2E_PLATFORM_PASSWORD
E2E_PLATFORM_TOTP_SECRET   # base32 secret for the seeded account
```

`auth.setup.ts` generates a live TOTP code from that secret with the same
`otpauth` library the server verifies with, so the test exercises the real
two-factor path rather than bypassing it. All three skip cleanly when unset.

### These credentials are LOCAL / STAGING ONLY

**No platform test account may exist on the production database.** A platform
account is the highest-privilege identity in the system: it can suspend a
customer, offboard them, cut their dialplan, and grant itself read access to
every tenant's call recordings. An account whose password sits in CI
environment variables must never have that reach over real customers.

`auth.setup.ts` refuses to run when `E2E_BASE_URL` points at a known
production host, rather than relying on care. If you need to verify the
console against production, do it by hand with a real operator account.

### What these specs cover

| Spec | Acceptance criterion |
|---|---|
| `platform-support-lifecycle` | Support user creation, one-time password, 24h grant ceiling, tenant-visible banner, revocation, audit trail |
| `platform-billing-ladder` | Grace warning → login block → tenant-admin exemption → restore, plus the structural "telephony untouched" assertions |
| `platform-guardrails` | Last-owner protection, cross-plane login rejection, dialplan cut typed confirmation and its absence from billing |
| `platform-overview` | Displayed figures match the API; health strip; attention-queue deep links |
| `platform-provisioning-dryrun` | Slug validation, run start, pause at the human certificate gate with the exact manual command |

### What they deliberately do NOT cover

Placing a real call while a tenant is suspended. Playwright cannot dial a GSM
number. That check is a documented manual blocker in `GO_LIVE_CHECKLIST.md`
Gate 1b, and the billing spec's own header says so rather than implying
coverage it does not have.
