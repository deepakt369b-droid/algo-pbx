# Algo PBX — Agent Context

You are working on **Algo PBX** — a self-hosted, cloud-based PBX (3CX alternative):
Asterisk 20 (PJSIP, host-networked Docker) + Next.js 14 WebRTC softphone (SIP.js) +
Coturn + PostgreSQL 16/Prisma + Dinstar UC2000 GSM trunk over Tailscale + OpenWA
WhatsApp sidecar. Agents in India, trunk in UAE.

## Read first, in this order

1. **`LLM.md`** — build-state tracker: constraints, decisions, phase checklist,
   build log. Treat recorded architecture decisions as locked unless the user
   explicitly reopens them. **After any work session that changes build state,
   update `LLM.md`'s Build Log and Phase Checklist before ending the session.**
2. `ALGO_PBX_MASTER_DOC.md` — PRD, architecture diagrams, tech stack (spec
   source of truth; its §6 config samples are historical reference only).
3. `DEPLOYMENT.md` + `GO_LIVE_CHECKLIST.md` — how to deploy and what to verify.
4. `handoff.md` — most recent session summary.
5. `docs/` — operator-facing PDF guides (regenerate via `scripts/build-docs.py`).

## Hard constraints (LLM.md §2 — do not relitigate)

- Asterisk runs with `network_mode: host`. Never containerize-network it.
- WebRTC media is DTLS-SRTP; signaling is WSS-only for agents.
- The Dinstar gateway is reached ONLY via the Tailscale subnet route — never a
  public port on the UAE router.
- Design language: dark slate `#0B0F19`, electric cyan `#06B6D4`, blue
  `#2563EB`, glassmorphic cards — no generic AI-template UI.
- Codecs: alaw/ulaw toward the Dinstar trunk; Opus/G.711 for WebRTC agents.
- Prisma (not Drizzle), AMI (not ARI), vitest for tests, Auth.js v5 credentials.

## Commands (run inside `algo-pbx-frontend/`)

```
npm run typecheck   # tsc --noEmit
npm run test        # vitest run
npm run lint        # next lint
npm run build       # next production build
```

Verify with typecheck + tests + build after every code change. Nothing in this
repo has ever carried a live call — see `GO_LIVE_CHECKLIST.md` before trusting
any call-path behavior on real infrastructure.
