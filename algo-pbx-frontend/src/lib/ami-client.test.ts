import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { AmiClient } from "./ami-client";
import type net from "node:net";

// Minimal net.Socket stand-in: real AmiClient only calls .once/.on/.write/.end
// on the socket, so a plain EventEmitter with those four methods is a
// faithful enough substitute — no need to spin up a real TCP server per test.
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

/**
 * Builds a connected AmiClient wired to a FakeSocket, having already
 * completed the login handshake AmiClient.connect() performs internally.
 * AmiClient increments its ActionID counter starting at 1, and connect()
 * sends the Login action first, so the login handshake always uses
 * ActionID "1" — every action sent by the test after this uses ActionID "2"
 * onward.
 */
async function createConnectedClient() {
  const socket = new FakeSocket();
  const client = new AmiClient(
    { host: "test-host", port: 1234, username: "u", secret: "s" },
    () => socket as unknown as net.Socket
  );

  const connecting = client.connect();
  socket.emit("connect");
  socket.emit("data", Buffer.from(loginAckBlock("1")));
  await connecting;

  return { client, socket };
}

describe("AmiClient CRLF injection protection", () => {
  it("refuses to send an action whose field contains a CR/LF", async () => {
    const { client } = await createConnectedClient();

    await expect(
      client.send({ Action: "Originate", Channel: "PJSIP/1001\r\nAction: Command\r\nCommand: id" })
    ).rejects.toThrow(/CR\/LF/);
  });

  it("refuses via sendAndCollect too, not just send", async () => {
    const { client } = await createConnectedClient();

    await expect(
      client.sendAndCollect({ Action: "QueueStatus", Queue: "x\r\nAction: Command" }, "QueueStatusComplete")
    ).rejects.toThrow(/CR\/LF/);
  });

  it("does not write anything to the socket when a field is rejected", async () => {
    const { client, socket } = await createConnectedClient();
    // createConnectedClient() already performed the login handshake, which
    // itself writes one message — assert the REJECTED send() adds no
    // further write, not that the socket has never been written to at all.
    const writesBeforeRejectedSend = socket.written.length;
    await client.send({ Action: "Ping", Data: "a\nb" }).catch(() => undefined);
    expect(socket.written).toHaveLength(writesBeforeRejectedSend);
  });
});

describe("AmiClient.sendAndCollect", () => {
  it("collects all events sharing the ActionID up to the terminator, inclusive", async () => {
    const { client, socket } = await createConnectedClient();

    const collecting = client.sendAndCollect({ Action: "QueueStatus", Queue: "support_queue" }, "QueueStatusComplete");

    // Action sent as ActionID "2" (login consumed "1").
    socket.emit("data", Buffer.from("Response: Success\r\nActionID: 2\r\n\r\n"));
    socket.emit(
      "data",
      Buffer.from("Event: QueueParams\r\nActionID: 2\r\nQueue: support_queue\r\nCalls: 3\r\n\r\n")
    );
    socket.emit(
      "data",
      Buffer.from("Event: QueueEntry\r\nActionID: 2\r\nQueue: support_queue\r\nWait: 42\r\n\r\n")
    );
    socket.emit(
      "data",
      Buffer.from("Event: QueueStatusComplete\r\nActionID: 2\r\nEventList: Complete\r\nListItems: 2\r\n\r\n")
    );

    const result = await collecting;

    expect(result.response.Response).toBe("Success");
    expect(result.events).toHaveLength(3);
    expect(result.events.map((e) => e.Event)).toEqual(["QueueParams", "QueueEntry", "QueueStatusComplete"]);
  });

  it("reassembles AMI blocks split across multiple TCP chunks", async () => {
    const { client, socket } = await createConnectedClient();

    const collecting = client.sendAndCollect({ Action: "CoreShowChannels" }, "CoreShowChannelsComplete");

    const fullBlock = "Event: CoreShowChannel\r\nActionID: 2\r\nChannel: PJSIP/1001-000000\r\n\r\n";
    const splitPoint = 20; // arbitrary point mid-block, not on a line boundary
    socket.emit("data", Buffer.from("Response: Success\r\nActionID: 2\r\n\r\n"));
    socket.emit("data", Buffer.from(fullBlock.slice(0, splitPoint)));
    socket.emit("data", Buffer.from(fullBlock.slice(splitPoint)));
    socket.emit(
      "data",
      Buffer.from("Event: CoreShowChannelsComplete\r\nActionID: 2\r\nListItems: 1\r\n\r\n")
    );

    const result = await collecting;

    expect(result.events).toHaveLength(2);
    expect(result.events[0].Channel).toBe("PJSIP/1001-000000");
  });

  it("ignores events belonging to a different, concurrently-issued ActionID", async () => {
    const { client, socket } = await createConnectedClient();

    const collecting = client.sendAndCollect({ Action: "QueueStatus" }, "QueueStatusComplete");

    // Ack for our action (ActionID 2).
    socket.emit("data", Buffer.from("Response: Success\r\nActionID: 2\r\n\r\n"));
    // An unrelated concurrent action's event (ActionID 99) must not be collected.
    socket.emit("data", Buffer.from("Event: QueueEntry\r\nActionID: 99\r\nWait: 999\r\n\r\n"));
    socket.emit("data", Buffer.from("Event: QueueEntry\r\nActionID: 2\r\nWait: 5\r\n\r\n"));
    socket.emit("data", Buffer.from("Event: QueueStatusComplete\r\nActionID: 2\r\n\r\n"));

    const result = await collecting;

    expect(result.events).toHaveLength(2);
    expect(result.events.every((e) => e.ActionID === "2")).toBe(true);
  });

  it("rejects and removes its event listener on timeout", async () => {
    const { client, socket } = await createConnectedClient();
    const listenersBefore = client.listenerCount("event");

    await expect(
      client.sendAndCollect({ Action: "QueueStatus" }, "QueueStatusComplete", 10)
    ).rejects.toThrow(/timed out/i);

    expect(client.listenerCount("event")).toBe(listenersBefore);
  });

  it("short-circuits on an Error response without waiting for a terminator", async () => {
    const { client, socket } = await createConnectedClient();

    const collecting = client.sendAndCollect({ Action: "QueueStatus" }, "QueueStatusComplete");
    socket.emit(
      "data",
      Buffer.from("Response: Error\r\nActionID: 2\r\nMessage: No such queue\r\n\r\n")
    );

    await expect(collecting).rejects.toThrow(/No such queue/);
  });
});
