import { runAmiAction } from "./ami-connection";

// The ONE mutating AMI action the MCP server can perform. Kept in its own
// file, away from ami-readonly.ts, so that "which file can change PBX state"
// has a one-word answer during review.
//
// The action is fully fixed — no parameters at all — so there is no input
// from the tool caller to validate: the only thing an approved caller can
// do is decide *whether* it runs, never *what* runs.
//
// `Command: pjsip reload` mirrors src/lib/pjsip-provision.ts exactly, and for
// the same reason recorded there: Asterisk's dedicated `Action: Reload` with
// `Module: res_pjsip` performs a module reload, which does NOT reliably pick
// up changes in an #include'd file the way the CLI's `pjsip reload` does. If
// that turns out to be wrong against a live Asterisk 20 (it is flagged as
// UNVERIFIED in pjsip-provision.ts too), both call sites must change
// together.

/** The exact AMI action this module would send. Returned verbatim by the
 *  tool's dry-run response so an operator approves a concrete thing, not a
 *  description of a thing. */
export const PJSIP_RELOAD_ACTION = { Action: "Command", Command: "pjsip reload" } as const;

export async function sendPjsipReload(): Promise<string> {
  const result = await runAmiAction({ ...PJSIP_RELOAD_ACTION });
  const text = result.output.join("\n").trim();
  return text || result.headers.Message || result.headers.Response || "(no output)";
}
