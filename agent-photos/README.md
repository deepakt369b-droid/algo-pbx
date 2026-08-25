# Agent profile photos

Populated at runtime by `POST /api/register/photo` (see
`algo-pbx-frontend/src/lib/agent-photo.ts` and that route) — never
committed to git. Files are named by a random UUID
(`<uuid>.jpg`), always re-encoded JPEG with EXIF stripped regardless of
the original upload format.

Served back only through the authenticated
`GET /api/me/photo/[id]` route (`[id]` is the owning `User.id`, not a
filename) — visible to the user themselves and to ADMIN/SUPERVISOR,
never to other agents. Nothing under this directory is served statically.
