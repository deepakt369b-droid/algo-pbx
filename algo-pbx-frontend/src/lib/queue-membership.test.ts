import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type net from "node:net";
import { AmiClient } from "./ami-client";
import { addQueueMember, pauseQueueMember, reconcileQueueMembership, removeQueueMember } from "./queue-membership";

class FakeSocket extends EventEmitter {
  written: string[] = [];
  write(data: string, cb?: (err?: Error) => void) {
    this.written.push(data);
    cb?.();
    return true;
  }
  end() {
    /* no-op */
  }
}

function loginAckBlock(actionId: string) {
  return `Response: Success\r\nActionID: ${actionId}\r\nMessage: Authentication accepted\r\n\r\n`;
}

async function createConnectedClient() {
  const socket = new FakeSocket();
  const client = new AmiClient({ host: "test-host", port: 1234, username: "u", secret: "s" }, () => socket as unknown as net.Socket);

  const connecting = client.connect();
  socket.emit("connect");
  socket.emit("data", Buffer.from(loginAckBlock("1")));
  await connecting;

  return { client, socket };
}

function parseFrame(frame: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of frame.trim().split("\r\n")) {
    const idx = line.indexOf(":");
    out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}

describe("queue-membership", () => {
  it("addQueueMember sends a QueueAdd action for the right interface", async () => {
    const { client, socket } = await createConnectedClient();
    const promise = addQueueMember(client, "1002");
    await new Promise((resolve) => setImmediate(resolve));
    const frame = parseFrame(socket.written[socket.written.length - 1]);
    expect(frame.Action).toBe("QueueAdd");
    expect(frame.Queue).toBe("support_queue");
    expect(frame.Interface).toBe("PJSIP/1002");
    socket.emit("data", Buffer.from(`Response: Success\r\nActionID: ${frame.ActionID}\r\n\r\n`));
    await promise;
  });

  it("removeQueueMember sends a QueueRemove action", async () => {
    const { client, socket } = await createConnectedClient();
    const promise = removeQueueMember(client, "1002");
    await new Promise((resolve) => setImmediate(resolve));
    const frame = parseFrame(socket.written[socket.written.length - 1]);
    expect(frame.Action).toBe("QueueRemove");
    expect(frame.Interface).toBe("PJSIP/1002");
    socket.emit("data", Buffer.from(`Response: Success\r\nActionID: ${frame.ActionID}\r\n\r\n`));
    await promise;
  });

  it("pauseQueueMember sets Paused: true/false correctly", async () => {
    const { client, socket } = await createConnectedClient();
    const promise = pauseQueueMember(client, "1002", true);
    await new Promise((resolve) => setImmediate(resolve));
    const frame = parseFrame(socket.written[socket.written.length - 1]);
    expect(frame.Action).toBe("QueuePause");
    expect(frame.Paused).toBe("true");
    socket.emit("data", Buffer.from(`Response: Success\r\nActionID: ${frame.ActionID}\r\n\r\n`));
    await promise;
  });

  it("reconcileQueueMembership only adds extensions missing from the live queue", async () => {
    const { client, socket } = await createConnectedClient();
    const promise = reconcileQueueMembership(client, ["1001", "1002"]);
    await new Promise((resolve) => setImmediate(resolve));

    // QueueStatus request/response cycle: ack, one QueueMember event for
    // 1001 already present, then the terminator.
    const statusFrame = parseFrame(socket.written[socket.written.length - 1]);
    expect(statusFrame.Action).toBe("QueueStatus");
    socket.emit("data", Buffer.from(`Response: Success\r\nActionID: ${statusFrame.ActionID}\r\n\r\n`));
    socket.emit(
      "data",
      Buffer.from(`Event: QueueMember\r\nActionID: ${statusFrame.ActionID}\r\nInterface: PJSIP/1001\r\n\r\n`)
    );
    socket.emit(
      "data",
      Buffer.from(`Event: QueueStatusComplete\r\nActionID: ${statusFrame.ActionID}\r\n\r\n`)
    );

    // Only 1002 (missing) should trigger a QueueAdd next.
    await new Promise((resolve) => setImmediate(resolve));
    const addFrame = parseFrame(socket.written[socket.written.length - 1]);
    expect(addFrame.Action).toBe("QueueAdd");
    expect(addFrame.Interface).toBe("PJSIP/1002");
    socket.emit("data", Buffer.from(`Response: Success\r\nActionID: ${addFrame.ActionID}\r\n\r\n`));

    const result = await promise;
    expect(result.alreadyPresent).toEqual(["1001"]);
    expect(result.added).toEqual(["1002"]);
  });
});
