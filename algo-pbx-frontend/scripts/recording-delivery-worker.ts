/**
 * Recording delivery worker.
 *
 *   npm run recording-delivery-worker          # one pass, then exit
 *   npm run recording-delivery-worker -- --loop
 *
 * One pass per invocation by default, so it can be driven by cron (the
 * pattern the retention prune job already uses) rather than requiring a
 * long-lived process to be supervised. --loop exists for a container that
 * would rather stay up.
 *
 * The worker holds no policy: what is due, what is worth retrying, and what
 * may be deleted all come from src/lib/recordings/delivery-policy.ts, which
 * is pure and unit-tested. Read that file to understand the behaviour; this
 * one only schedules it.
 */
import { enqueuePending, runDeliveryPass } from "../src/lib/recordings/delivery/worker";

const loop = process.argv.includes("--loop");
const INTERVAL_MS = Number(process.env.DELIVERY_WORKER_INTERVAL_MS || 60_000);

async function onePass() {
  const started = Date.now();
  const enqueued = await enqueuePending();
  const result = await runDeliveryPass();

  console.log(
    JSON.stringify({
      at: new Date().toISOString(),
      ms: Date.now() - started,
      enqueued,
      ...result,
    })
  );

  // Delivered-but-unverified is the state worth shouting about: the upload
  // succeeded and the read-back did not match, which means the remote copy is
  // not trustworthy and nothing will be purged. Silent accumulation here is
  // how a broken target goes unnoticed for weeks.
  if (result.delivered > result.verified) {
    console.warn(
      `WARNING: ${result.delivered - result.verified} delivery/deliveries succeeded but FAILED read-back verification. ` +
        `No local file will be purged for those. Check the target's storage.`
    );
  }
}

async function main() {
  if (!loop) {
    await onePass();
    return;
  }
  console.log(`Delivery worker looping every ${INTERVAL_MS}ms. Ctrl-C to stop.`);
  for (;;) {
    try {
      await onePass();
    } catch (err) {
      // A failed pass must not kill the loop — the next one may well succeed,
      // and an exited worker delivers nothing at all.
      console.error("Delivery pass failed:", err instanceof Error ? err.message : err);
    }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
