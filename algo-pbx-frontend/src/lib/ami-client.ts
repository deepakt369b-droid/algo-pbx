import { EventEmitter } from "node:events";
import net from "node:net";

// Minimal Asterisk Manager Interface (AMI) client — Phase 4 "REST API for
// AMI/ARI management" from LLM.md. Deliberately hand-rolled instead of a
// third-party AMI package: the protocol is a simple line-oriented text
// protocol (blocks separated by \r\n\r\n) and this app only needs a handful
// of actions (login, originate, queue status, hangup), not a full client.
//
// Server-only: must never be imported from a client component. Requires
// manager.conf on the Asterisk side (pbx_configs/manager.conf) exposing this
// user on port 5038 — reachable directly since Asterisk runs with
// network_mode: host alongside this container's host network.

export type AmiEvent = Record<string, string> & { Event?: string };

interface AmiClientOptions {
  host: string;
  port: number;
  username: string;
  secret: string;
}

export class AmiClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private buffer = "";
  private pendingActionId = 0;
  private connected = false;
  private connecting: Promise<void> | null = null;

  constructor(
    private opts: AmiClientOptions,
    // Injectable so tests can substitute a fake socket instead of opening a
    // real TCP connection — see ami-client.test.ts. Defaults to the real
    // net.createConnection for production use.
    private socketFactory: () => net.Socket = () =>
      net.createConnection({ host: opts.host, port: opts.port })
  ) {
    super();
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.connecting) return this.connecting;

    this.connecting = new Promise((resolve, reject) => {
      const socket = this.socketFactory();
      this.socket = socket;

      socket.once("error", (err) => {
        this.connecting = null;
        reject(err);
      });

      socket.once("connect", async () => {
        try {
          socket.on("data", (chunk) => this.onData(chunk.toString("utf8")));
          await this.login();
          this.connected = true;
          this.connecting = null;
          resolve();
        } catch (err) {
          this.connecting = null;
          reject(err);
        }
      });

      socket.on("close", () => {
        this.connected = false;
        this.socket = null;
      });
    });

    return this.connecting;
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    let boundary: number;
    while ((boundary = this.buffer.indexOf("\r\n\r\n")) !== -1) {
      const raw = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 4);
      const block = this.parseBlock(raw);
      if (block.Event) this.emit("event", block);
      if (block.ActionID) this.emit(`response:${block.ActionID}`, block);
    }
  }

  private parseBlock(raw: string): AmiEvent {
    const result: AmiEvent = {};
    for (const line of raw.split("\r\n")) {
      const idx = line.indexOf(":");
      if (idx === -1) continue;
      result[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
    return result;
  }

  private async login(): Promise<void> {
    const res = await this.send({
      Action: "Login",
      Username: this.opts.username,
      Secret: this.opts.secret,
    });
    if (res.Response !== "Success") {
      throw new Error(`AMI login failed: ${res.Message ?? "unknown error"}`);
    }
  }

  /** Builds the wire-format message and reserves the next ActionID. Shared
   * by send() and sendAndCollect() so the two never drift apart.
   *
   * SECURITY: every field value is validated against CR/LF before being
   * joined into the wire message. This was previously unguarded — values
   * were interpolated straight into `${k}: ${v}\r\n` with no escaping —
   * and two callers (api/intervention/route.ts's supervisorExtension/
   * targetChannel, api/calls/conference/route.ts's targetNumber) accepted
   * that value from request-body strings validated only by loose Zod
   * schemas (bare `z.string()` / `.min(3)`, no character restriction). A
   * value containing "\r\n" could append an entirely separate AMI action
   * to the message — including `Action: Command`, which executes an
   * arbitrary Asterisk CLI command, i.e. remote code execution reachable
   * from a plain AGENT session via the conference route. There is no safe
   * way to *escape* CR/LF within a single AMI field (the protocol has no
   * escaping mechanism), so this rejects rather than sanitizes — the same
   * choice src/lib/pjsip-config.ts's assertSafe() already made for the
   * config-file injection class of this same bug. Route-level Zod schemas
   * are ALSO tightened to numeric/channel-shaped regexes (defense in
   * depth), but this is the layer that makes the vulnerability
   * structurally impossible regardless of what a future caller forgets to
   * validate. */
  private frameAction(fields: Record<string, string>): { actionId: string; message: string } {
    const actionId = String(++this.pendingActionId);
    const payload = { ActionID: actionId, ...fields };
    for (const [k, v] of Object.entries(payload)) {
      if (/[\r\n]/.test(v)) {
        throw new Error(`AMI action field "${k}" contains a CR/LF character — refusing to send (possible header injection).`);
      }
    }
    const lines = Object.entries(payload).map(([k, v]) => `${k}: ${v}`);
    return { actionId, message: lines.join("\r\n") + "\r\n\r\n" };
  }

  /** Send an AMI action and wait for its correlated response. */
  async send(fields: Record<string, string>): Promise<AmiEvent> {
    if (!this.socket) throw new Error("AMI socket not connected");
    const { actionId, message } = this.frameAction(fields);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.removeAllListeners(`response:${actionId}`);
        reject(new Error(`AMI action timed out: ${fields.Action}`));
      }, 5000);

      this.once(`response:${actionId}`, (block: AmiEvent) => {
        clearTimeout(timeout);
        resolve(block);
      });

      this.socket!.write(message, (err) => {
        if (err) {
          clearTimeout(timeout);
          reject(err);
        }
      });
    });
  }

  /**
   * Send an AMI action that produces a multi-event response list — an
   * initial ack Response, then N Event blocks, then a terminating event
   * (e.g. QueueStatus -> QueueStatusComplete, CoreShowChannels ->
   * CoreShowChannelsComplete). `send()` only ever resolves on the initial
   * ack, which is the root cause this method fixes: e.g. CoreShowChannels's
   * ListItems count lives on the *terminating* event, not the ack.
   *
   * Per Asterisk 20's documented AMI behavior, every event belonging to the
   * action's response list echoes the same ActionID as the originating
   * action, which is what makes correlation possible at all.
   */
  async sendAndCollect(
    fields: Record<string, string>,
    terminatorEvent: string,
    timeoutMs = 8000
  ): Promise<{ response: AmiEvent; events: AmiEvent[] }> {
    if (!this.socket) throw new Error("AMI socket not connected");
    const { actionId, message } = this.frameAction(fields);
    const events: AmiEvent[] = [];

    return new Promise((resolve, reject) => {
      let response: AmiEvent | null = null;

      const cleanup = () => {
        clearTimeout(timeout);
        this.removeListener("event", onEvent);
        this.removeAllListeners(`response:${actionId}`);
      };

      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`AMI collecting action timed out: ${fields.Action}`));
      }, timeoutMs);

      // Registered before writing to the socket (below) so no event for
      // this ActionID can arrive un-listened-for.
      const onEvent = (block: AmiEvent) => {
        if (block.ActionID !== actionId) return;
        events.push(block);
        if (block.Event === terminatorEvent) {
          cleanup();
          resolve({ response: response ?? block, events });
        }
      };
      this.on("event", onEvent);

      this.once(`response:${actionId}`, (block: AmiEvent) => {
        response = block;
        if (block.Response === "Error") {
          cleanup();
          reject(new Error(`AMI action failed: ${block.Message ?? "unknown error"}`));
        }
      });

      this.socket!.write(message, (err) => {
        if (err) {
          cleanup();
          reject(err);
        }
      });
    });
  }

  disconnect() {
    this.socket?.end();
    this.socket = null;
    this.connected = false;
  }

  get isConnected() {
    return this.connected;
  }
}

// Singleton across route handler invocations, same rationale as src/lib/db.ts.
const globalForAmi = globalThis as unknown as { amiClient?: AmiClient };

export function getAmiClient(): AmiClient {
  if (!globalForAmi.amiClient) {
    globalForAmi.amiClient = new AmiClient({
      host: process.env.AMI_HOST || "127.0.0.1",
      port: Number(process.env.AMI_PORT || 5038),
      username: process.env.AMI_USERNAME || "algopbx-app",
      secret: process.env.AMI_SECRET || "",
    });
  }
  return globalForAmi.amiClient;
}
