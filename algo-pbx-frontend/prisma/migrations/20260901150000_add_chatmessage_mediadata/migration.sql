-- Capture WhatsApp media bytes at ingest (2026-09-01). OpenWA's
-- /messages/:chatId/:id/media sub-endpoint 404s for received media it never
-- archived, but the base64 IS present in the /messages list response under
-- metadata.media.data — so ingest.ts stashes it here (size-capped). Additive.

ALTER TABLE "ChatMessage" ADD COLUMN "mediaData" TEXT;
