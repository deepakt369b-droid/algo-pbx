# Handoff — Algo PBX deployment docs + pre-deployment bug sweep

Last updated: 2026-08-23, later session. This file tracks what was done and
what still needs a human decision.

## What was asked

1. Continue from the previous handoff: close the open production-build and
   PDF-screenshot items.
2. Run a repo-wide bug sweep before deployment and fix anything surfaced
   (hydration and other deployment-blocking bugs).
3. Invoke the relevant skills while doing the sweep.

## Done

- **Code sweep completed** using `find-skills` (no suitable bug-hunt skill
  installed) and `ponytail-audit` (repo-wide over-engineering audit; its
  correctness/security findings were folded into the bug sweep). Three
  explore subagents scanned `algo-pbx-frontend/src`, `src/app/api` + `src/lib`,
  and the repo root infra files.

- **Bugs fixed / deployment blockers removed:**
  - `docker-compose.yml` — the `web` service build had no `target`, so Docker
    built through to the final Dockerfile stage (`cdr-listener`) instead of
    the Next.js `runner` stage. Added `target: runner`.
  - `.gitignore` — `.env.local` and `docker-compose.override.yml` were not
    ignored; both are local-only and must not be committed. Added entries.
  - `src/middleware.ts` — matcher regex `(?!api|...)` would also skip future
    routes like `/apiography`. Fixed to `(?!api/|api$|...)` and reverted the
    matcher to exclude `/login` and `/setup` again now that CSP is static.
  - `src/app/api/me/turn-credentials/route.ts` — `VM_PUBLIC_DOMAIN` was used
    unchecked, producing `stun:undefined:3478` etc. Added a 503 guard.
  - `src/app/api/register/route.ts` — returned `phoneVerified: true` when the
    phone number was unchanged even if it had never been verified. Now checks
    `current.phoneVerifiedAt`.
  - Hydration/CSP fix re-landed in a simpler, production-verified form: the
    nonce-based CSP worked in `next dev` but Next.js 14.2 standalone does not
    automatically nonce its own external `<script src>` chunks in production,
    so `'strict-dynamic'` blocked them and inline scripts still lacked nonces.
    Replaced the per-request nonce CSP with a static CSP in
    `next.config.mjs` using `script-src 'self' 'unsafe-inline'` (plus
    `'unsafe-eval'` only in development for Fast Refresh). Middleware now only
    handles auth gating; security headers are set once in `next.config.mjs`.

- **Production standalone build verified:**
  - `cd algo-pbx-frontend && npm run build` succeeds.
  - `.next/static` and `public/` copied into the standalone output directory.
  - Standalone server running on port 3000 (background task) with env from
    `.env.local` and `PORT=3000`.
  - `curl` confirms CSP header: `script-src 'self' 'unsafe-inline'` (no
    `'unsafe-eval'` in production).
  - Playwright confirms `/setup` hydrates to the real "Welcome to Algo PBX"
    admin-creation form, `/login` renders, and `/admin/settings` loads after
    creating a local admin.

- **PDF 2 regenerated with real screenshots:**
  - Captured live full-page screenshots of `/setup` and `/admin/settings`
    against the production standalone build.
  - Rebuilt the HTML source as `docs/pdf2-template.html` +
    `scripts/build-pdf2.py` → `docs/pdf2-source.html`.
  - Generated `docs/2-Configuring-Credentials-Dinstar-and-Going-Live.pdf`
    via headless Chrome `--print-to-pdf`.
  - Verified the PDF contains the embedded screenshots (pages 3, 4, 14).

- **Infra / script / security fixes from the sweep:**
  - `scripts/setup-tailscale-uae-office.sh` — made `net.ipv4.ip_forward = 1`
    idempotent (no more duplicated lines on re-run).
  - `scripts/setup-tailscale-cloud.sh` — made `--accept-routes` idempotent by
    using `tailscale set --accept-routes` when already logged in.
  - `pbx_configs/odbc.ini` — added a comment about keeping the port in sync
    with `docker-compose.yml` / any local override.
  - `src/lib/webhooks.ts` — added an SSRF guard rejecting private/reserved
    hosts, non-http(s) schemes, and non-standard ports for admin-controlled
    webhook URLs.
  - `src/lib/api-handler.ts` — introduced `withApiErrorHandler` wrapper.
    Applied it to `POST/GET /api/setup`, `POST/GET /api/invite`,
    `POST/GET /api/register`, `GET/POST /api/admin/users`,
    `GET/PATCH /api/admin/settings`, `GET/POST /api/extensions`, and
    `GET/POST /api/cdr` so unexpected errors return a generic 500 instead of
    leaking stack traces or provider messages.
  - `src/lib/settings/service.ts` — added a production warning and a
    `DISABLE_SETTINGS_CACHE=true` escape hatch for multi-replica deployments.

- **Verification:**
  - `npm run typecheck` passes.
  - `npm test` passes (170 tests).
  - `npm run mcp-server` starts without immediate error.
  - Rebuilt production standalone and restarted the server on port 3000;
    smoke-tested `/api/setup` and `/api/invite`.

- **Typecheck passes** (`npm run typecheck`). `npm run lint` is not usable yet
  because the repo has no ESLint config; running `next lint` interactively
  prompts to create one.

## Still open / next steps

1. **No Git repository exists here**, so `git rm --cached` is moot. If this
   project is ever initialized or pushed, ensure `docker-compose.override.yml`
   is not tracked.

2. **API error handling coverage** is improved but not exhaustive. The
   remaining mutating routes still do unwrapped DB writes and leak raw errors.
   The new `withApiErrorHandler` can be applied to them in a follow-up pass.

3. **PDF 1** was not regenerated in this session; it still has no real
   screenshots.

4. **Local secrets remain in `.env` and `algo-pbx-frontend/.env.local`** —
   both are now git-ignored, but never reuse them for a real deployment.

## Key files touched this session

- `docker-compose.yml` — added `target: runner` to the `web` build.
- `.gitignore` — added `.env.local` and `docker-compose.override.yml`.
- `algo-pbx-frontend/src/middleware.ts` — removed CSP/header handling; auth
  gating only. Matcher fixed and reverted to exclude `/login` and `/setup`.
- `algo-pbx-frontend/next.config.mjs` — static CSP with `'unsafe-inline'`
  plus the non-CSP security headers.
- `algo-pbx-frontend/src/app/api/me/turn-credentials/route.ts` — added
  missing `VM_PUBLIC_DOMAIN` validation.
- `algo-pbx-frontend/src/app/api/register/route.ts` — fixed `phoneVerified`
  logic and selected `phoneVerifiedAt`.
- `algo-pbx-frontend/src/lib/webhooks.ts` — SSRF guard.
- `algo-pbx-frontend/src/lib/api-handler.ts` — new error-handler wrapper.
- `algo-pbx-frontend/src/app/api/setup/route.ts`,
  `algo-pbx-frontend/src/app/api/invite/route.ts`,
  `algo-pbx-frontend/src/app/api/register/route.ts`,
  `algo-pbx-frontend/src/app/api/admin/users/route.ts`,
  `algo-pbx-frontend/src/app/api/admin/settings/route.ts`,
  `algo-pbx-frontend/src/app/api/extensions/route.ts`,
  `algo-pbx-frontend/src/app/api/cdr/route.ts` — wrapped with error handler.
- `algo-pbx-frontend/src/lib/settings/service.ts` — cache warning + disable flag.
- `scripts/setup-tailscale-uae-office.sh`, `scripts/setup-tailscale-cloud.sh`
  — idempotency fixes.
- `pbx_configs/odbc.ini` — port-sync comment.
- `docs/pdf2-template.html`, `scripts/build-pdf2.py`, `docs/pdf2-source.html`,
  `docs/2-Configuring-Credentials-Dinstar-and-Going-Live.pdf` — regenerated
  PDF 2 with live screenshots.
- `handoff.md` — this file.
