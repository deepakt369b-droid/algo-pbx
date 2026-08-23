#!/usr/bin/env -S node --enable-source-maps
// Standalone, long-running process that subscribes to Asterisk AMI `Cdr`
// events and forwards each one to POST /api/cdr. Deliberately NOT a Next.js
// instrumentation.ts hook: an AMI subscription needs exactly one durable TCP
// connection with reconnect/backoff, and instrumentation hooks run per
// server worker with no single-execution guarantee across dev restarts,
// multiple workers, or redeploys — that risks duplicate or dropped
// ingestion. A separate process also keeps AMI credentials out of the
// request-handling web tier and can be restarted independently of it.
//
// Run via `npm run cdr-listener` (tsx, see package.json) or as its own
// container (docker-compose.yml's `cdr-listener` service).
//
// Field names read off the Cdr event (UniqueID, Source, Destination,
// CallerID, Disposition, StartTime, AnswerTime, EndTime, Duration,
// BillableSeconds) are Asterisk's conventional names for manager.conf's
// `read = cdr` class — UNVERIFIED against a live capture, same caveat as
// src/lib/cdr-mapper.ts carries.

import { AmiClient, type AmiEvent } from "../src/lib/ami-client";
import { mapCdrEventToIngestPayload } from "../src/lib/cdr-mapper";

const AMI_HOST = process.env.AMI_HOST || "127.0.0.1";
const AMI_PORT = Number(process.env.AMI_PORT || 5038);
const AMI_USERNAME = process.env.AMI_USERNAME || "algopbx-app";
const AMI_SECRET = process.env.AMI_SECRET || "";
const CDR_INGEST_URL = process.env.CDR_INGEST_URL || "http://web:3000/api/cdr";
const CDR_INGEST_SECRET = process.env.CDR_INGEST_SECRET || "";
const RECORDING_URL_BASE = "/api/recordings";

if (!AMI_SECRET || !CDR_INGEST_SECRET) {
  console.error("ami-cdr-listener: AMI_SECRET and CDR_INGEST_SECRET must both be set. Exiting.");
  process.exit(1);
}

async function ingest(event: AmiEvent) {
  // The dialplan context the call originated from determines direction
  // (see cdr-mapper.ts's inferDirection) — Asterisk's Cdr event exposes
  // this as `Context` in standard CDR field naming.
  const payload = mapCdrEventToIngestPayload(event, {
    sourceContext: event.Context,
    recordingUrlBase: RECORDING_URL_BASE,
  });

  if (!payload) {
    console.warn("ami-cdr-listener: skipping unmappable Cdr event", event);
    return;
  }

  try {
    const res = await fetch(CDR_INGEST_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CDR_INGEST_SECRET}`,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error(`ami-cdr-listener: ingest failed (${res.status}) for uniqueId=${payload.uniqueId}`);
    }
  } catch (err) {
    console.error("ami-cdr-listener: ingest request errored:", err);
  }
}

async function main() {
  const client = new AmiClient({ host: AMI_HOST, port: AMI_PORT, username: AMI_USERNAME, secret: AMI_SECRET });

  client.on("event", (event: AmiEvent) => {
    if (event.Event === "Cdr") {
      void ingest(event);
    }
  });

  // Simple reconnect-with-backoff loop — AMI connections can drop on
  // Asterisk restarts/reloads, and this process must not silently stop
  // ingesting CDRs when that happens.
  let backoffMs = 1000;
  const MAX_BACKOFF_MS = 30000;

  for (;;) {
    try {
      console.log(`ami-cdr-listener: connecting to AMI at ${AMI_HOST}:${AMI_PORT}...`);
      await client.connect();
      console.log("ami-cdr-listener: connected, listening for Cdr events.");
      backoffMs = 1000; // reset backoff after a successful connection

      // Block here until the connection drops. AmiClient doesn't currently
      // expose a "disconnected" event, so poll isConnected — cheap, and
      // avoids adding new public surface to ami-client.ts for a single
      // caller. Revisit if a second consumer needs the same signal.
      await new Promise<void>((resolve) => {
        const interval = setInterval(() => {
          if (!client.isConnected) {
            clearInterval(interval);
            resolve();
          }
        }, 2000);
      });
      console.warn("ami-cdr-listener: AMI connection lost, reconnecting...");
    } catch (err) {
      console.error("ami-cdr-listener: connection attempt failed:", err);
    }

    await new Promise((resolve) => setTimeout(resolve, backoffMs));
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
  }
}

main().catch((err) => {
  console.error("ami-cdr-listener: fatal error:", err);
  process.exit(1);
});
