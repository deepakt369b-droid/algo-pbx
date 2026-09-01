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
