import net from "node:net";

// Minimal, self-contained AMI transport for the internal MCP server.
//
// WHY THIS EXISTS INSTEAD OF REUSING src/lib/ami-client.ts:
//
//  1. Lifetime. The app's AmiClient is a process-global singleton with a
//     long-lived socket, sized for a Next.js server handling many requests.
//     The MCP server is a short-lived operator tool run from a terminal;
//     holding a persistent authenticated AMI socket open for the whole
//     session is strictly more exposure than opening one per tool call and
//     closing it immediately. Every function here opens its own connection,
//     runs exactly one action, and tears the socket down in a `finally`.
//
//  2. Multi-line `Output:`. Asterisk's `Command` action answers with a
//     response block containing MANY `Output:` headers (one per CLI output
//     line). AmiClient.parseBlock() folds a block into a
//     Record<string,string>, so repeated `Output:` keys collapse to the last
//     line only — fine for the app (which only ever checks Response) but
//     useless for a troubleshooting tool whose entire value is the CLI text.
//     This module keeps the raw block and collects Output lines in order.
//
// This file is NOT a general-purpose AMI client and must not become one. It
// exposes `runAmiAction`, which takes pre-built, structured fields; nothing
// in mcp-server/ ever passes caller-supplied free text into it (see
// ami-readonly.ts's enum-keyed allowlist and ami-reload.ts's single fixed
// action). Every field value is additionally CRLF-checked before it touches
// the wire, because AMI frames actions with \r\n and a newline inside a
// value would let one action smuggle a second one — the same class of bug
// pjsip-config.ts's assertSafe() guards against for config files.

export interface AmiActionResult {
  /** Parsed headers of the response block, last-wins for repeated keys. */
  headers: Record<string, string>;
  /** Every `Output:` line, in order — the actual CLI text for Command actions. */
  output: string[];
  /** The raw response block exactly as received, for debugging. */
  raw: string;
}

export interface AmiConnectionOptions {
  host: string;
  port: number;
  username: string;
  secret: string;
  timeoutMs: number;
}

export function amiOptionsFromEnv(): AmiConnectionOptions {
  return {
    host: process.env.AMI_HOST || "127.0.0.1",
    port: Number(process.env.AMI_PORT || 5038),
    username: process.env.AMI_USERNAME || "algopbx-app",
    secret: process.env.AMI_SECRET || "",
    timeoutMs: Number(process.env.MCP_AMI_TIMEOUT_MS || 10000),
  };
}

// AMI's line framing is `Key: Value\r\n`, blocks separated by `\r\n\r\n`. A
// \r or \n inside a value therefore terminates the header (or the whole
// action) early and lets the remainder be reinterpreted as new headers or a
// whole new action. Reject rather than strip: silently mangling an operator's
// input is worse than telling them it was rejected.
const AMI_UNSAFE = /[\r\n\0]/;

export function assertAmiSafe(value: string, field: string): void {
  if (AMI_UNSAFE.test(value)) {
    throw new Error(
      `AMI action field "${field}" contains a CR/LF/NUL character, which would break action framing. Refusing to send.`
    );
  }
}

function parseBlock(raw: string): { headers: Record<string, string>; output: string[] } {
  const headers: Record<string, string> = {};
  const output: string[] = [];
  for (const line of raw.split("\r\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) {
      // Asterisk's older `Command` responses end with a bare
      // `--END COMMAND--` line that carries no colon. Keep it out of both
      // headers and output rather than dropping the whole line silently.
      continue;
    }
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).replace(/^ /, "").replace(/\s+$/, "");
    if (key === "Output") {
      output.push(value);
    } else {
      headers[key] = value.trim();
    }
  }
  return { headers, output };
}

function frame(fields: Record<string, string>): string {
  for (const [k, v] of Object.entries(fields)) assertAmiSafe(v, k);
  return (
    Object.entries(fields)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\r\n") + "\r\n\r\n"
  );
}

/**
 * Open a dedicated AMI connection, log in, run exactly one action, and close.
 *
 * `fields` must be built by this package from an allowlist — never assembled
 * from an MCP tool caller's free-text input. See this file's header.
 */
export async function runAmiAction(
  fields: Record<string, string>,
  opts: AmiConnectionOptions = amiOptionsFromEnv()
): Promise<AmiActionResult> {
  if (!opts.secret) {
    throw new Error("AMI_SECRET is not set — refusing to attempt an unauthenticated AMI connection.");
  }

  const socket = net.createConnection({ host: opts.host, port: opts.port });
  socket.setEncoding("utf8");

  try {
    return await new Promise<AmiActionResult>((resolve, reject) => {
      let buffer = "";
      let stage: "greeting" | "login" | "action" = "greeting";
      let settled = false;

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.removeAllListeners("data");
        socket.removeAllListeners("error");
        fn();
      };

      const timer = setTimeout(
        () => finish(() => reject(new Error(`AMI action "${fields.Action}" timed out after ${opts.timeoutMs}ms`))),
        opts.timeoutMs
      );

      socket.on("error", (err) => finish(() => reject(err)));
      socket.on("close", () =>
        finish(() => reject(new Error(`AMI connection closed before "${fields.Action}" completed`)))
      );

      socket.on("data", (chunk: string) => {
        buffer += chunk;

        // The server greeting ("Asterisk Call Manager/x.y.z\r\n") is a single
        // line, not a \r\n\r\n-terminated block — consume it explicitly
        // before any block parsing, or it corrupts the first block boundary.
        if (stage === "greeting") {
          const nl = buffer.indexOf("\r\n");
          if (nl === -1) return;
          buffer = buffer.slice(nl + 2);
          stage = "login";
          socket.write(
            frame({ Action: "Login", ActionID: "mcp-login", Username: opts.username, Secret: opts.secret })
          );
        }

        let boundary: number;
        while ((boundary = buffer.indexOf("\r\n\r\n")) !== -1) {
          const raw = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 4);
          const parsed = parseBlock(raw);

          if (stage === "login") {
            if (parsed.headers.ActionID !== "mcp-login") continue; // stray event
            if (parsed.headers.Response !== "Success") {
              return finish(() =>
                reject(new Error(`AMI login failed: ${parsed.headers.Message ?? "unknown error"}`))
              );
            }
            stage = "action";
            socket.write(frame({ ...fields, ActionID: "mcp-action" }));
            continue;
          }

          // stage === "action". Ignore unsolicited events (AMI pushes them on
          // any authenticated connection) and wait for our correlated reply.
          if (parsed.headers.ActionID !== "mcp-action") continue;

          if (parsed.headers.Response === "Error") {
            return finish(() =>
              reject(new Error(`AMI action "${fields.Action}" failed: ${parsed.headers.Message ?? "unknown error"}`))
            );
          }
          return finish(() => resolve({ headers: parsed.headers, output: parsed.output, raw }));
        }
      });
    });
  } finally {
    socket.destroy();
  }
}
