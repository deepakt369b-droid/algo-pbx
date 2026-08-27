import type { AmiClient } from "@/lib/ami-client";

// Dynamic queue membership — the gap that meant a newly provisioned agent
// could never receive an inbound call: pbx_configs/queues.conf used to
// hardcode a single `member => PJSIP/1001` line and no AMI action anywhere
// in this codebase ever added or removed a member at runtime. That line is
// now gone (see queues.conf's comment) — this file is what keeps
// support_queue's live membership in sync with provisioned agents instead.
//
// `persistentmembers=yes` in queues.conf ([general]) is what makes a
// member added via AMI survive an Asterisk restart (Asterisk writes it to
// AstDB) — reconcileQueueMembership() below still exists for the case
// where the two have drifted (a fresh Asterisk boot with an
// already-provisioned agent, or a manual AstDB wipe).

const SUPPORT_QUEUE = "support_queue";

// AmiClient.send() now rejects on `Response: Error`. QueueAdd/QueueRemove
// answer with an error for the benign idempotent cases ("Unable to add
// interface: Already there" / "Unable to remove interface: Not there") —
// swallow only those, so re-running a provision or a disable is safe, but
// a real failure (auth, missing queue) still propagates.
function ignoreBenign(re: RegExp) {
  return (err: unknown) => {
    if (err instanceof Error && re.test(err.message)) return;
    throw err;
  };
}

export async function addQueueMember(ami: AmiClient, extensionNumber: string, queue = SUPPORT_QUEUE): Promise<void> {
  await ami.connect();
  await ami
    .send({ Action: "QueueAdd", Queue: queue, Interface: `PJSIP/${extensionNumber}`, Penalty: "0" })
    .then(() => undefined, ignoreBenign(/already there/i));
}

export async function removeQueueMember(ami: AmiClient, extensionNumber: string, queue = SUPPORT_QUEUE): Promise<void> {
  await ami.connect();
  await ami
    .send({ Action: "QueueRemove", Queue: queue, Interface: `PJSIP/${extensionNumber}` })
    .then(() => undefined, ignoreBenign(/not there|not currently a member/i));
}

export async function pauseQueueMember(
  ami: AmiClient,
  extensionNumber: string,
  paused: boolean,
  queue = SUPPORT_QUEUE
): Promise<void> {
  await ami.connect();
  await ami.send({ Action: "QueuePause", Queue: queue, Interface: `PJSIP/${extensionNumber}`, Paused: paused ? "true" : "false" });
}

/** Read current AMI membership for `queue` and add every extension in
 * `expectedExtensions` that is missing — idempotent, safe to run on every
 * boot/reconciliation pass. Does NOT remove members not in the expected
 * set (a manually-added on-call number should survive a reconciliation
 * pass, not be silently dropped). */
export async function reconcileQueueMembership(
  ami: AmiClient,
  expectedExtensions: string[],
  queue = SUPPORT_QUEUE
): Promise<{ added: string[]; alreadyPresent: string[] }> {
  await ami.connect();
  const { events } = await ami.sendAndCollect({ Action: "QueueStatus", Queue: queue }, "QueueStatusComplete");
  const current = new Set(
    events
      .filter((e) => e.Event === "QueueMember")
      .map((e) => /^PJSIP\/(\w+)/.exec(e.Interface ?? "")?.[1])
      .filter((n): n is string => Boolean(n))
  );

  const added: string[] = [];
  const alreadyPresent: string[] = [];
  for (const ext of expectedExtensions) {
    if (current.has(ext)) {
      alreadyPresent.push(ext);
    } else {
      await addQueueMember(ami, ext, queue);
      added.push(ext);
    }
  }
  return { added, alreadyPresent };
}
