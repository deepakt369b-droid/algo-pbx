import path from "node:path";

// Pure allowlist + redaction logic for the MCP server's filesystem and
// container tools. Isolated from the tools themselves (index.ts) so the
// security-relevant decisions — which file, which container, what gets
// redacted — are unit-testable with no Asterisk, Docker, or Postgres
// present. See allowlists.test.ts.

// ---------------------------------------------------------------------------
// PBX config files
// ---------------------------------------------------------------------------

// Repo layout: this file lives at <repo>/algo-pbx-frontend/mcp-server/, and
// `npm run mcp-server` runs from <repo>/algo-pbx-frontend/, so the config
// directory is one level up. Overridable for the containerised case where
// the configs are bind-mounted somewhere else (docker-compose.yml mounts
// pbx_configs/ into the asterisk container).
export function pbxConfigsDir(): string {
  return process.env.PBX_CONFIGS_DIR || path.resolve(process.cwd(), "..", "pbx_configs");
}

export function mohDir(): string {
  return process.env.MOH_DIR || path.resolve(process.cwd(), "..", "moh");
}

// Enum keys, not paths. `read_pbx_config` never accepts a path, a filename,
// or a fragment of either: a caller picks one of these names and this table
// decides what that means on disk. A path parameter — even one that "just"
// gets basename()'d — is how directory traversal and symlink escapes get in,
// and there is no operational need for one here: the set of files that
// matter is small, known, and changes about once a year.
const CONFIG_FILE_TABLE = {
  "pjsip-base.conf": { dir: "pbx_configs", redact: false },
  "pjsip_dynamic.conf": { dir: "pbx_configs", redact: true },
  "rtp.conf": { dir: "pbx_configs", redact: false },
  "extensions.conf": { dir: "pbx_configs", redact: false },
  "queues.conf": { dir: "pbx_configs", redact: false },
  "confbridge.conf": { dir: "pbx_configs", redact: false },
  // manager.conf holds the AMI account secrets this very server
  // authenticates with. Reading it is genuinely useful when debugging
  // permit/deny and read/write class problems; returning the secrets is
  // not, and would put them into an LLM's context (and whatever transcript
  // that context ends up in) for no benefit.
  "manager.conf": { dir: "pbx_configs", redact: true },
  "voicemail.conf": { dir: "pbx_configs", redact: true },
  "http.conf": { dir: "pbx_configs", redact: false },
  "asterisk.conf": { dir: "pbx_configs", redact: false },
} as const;

export type ConfigFileName = keyof typeof CONFIG_FILE_TABLE;

// Re-exported through a deliberately WIDER value type than the `as const`
// table infers. Keeping the key literals (so the tool's enum stays exact)
// while widening `dir` to the full union is what lets resolveConfigPath()'s
// moh/ branch type-check: every entry today lives in pbx_configs/, and moh/
// currently holds only audio (moh/default/*), which is not useful to return
// as text. The branch is kept because a text MOH config (musiconhold.conf
// lives in pbx_configs/, but a per-class file under moh/ would not) is the
// obvious next addition here.
export const CONFIG_FILES: Record<ConfigFileName, { dir: "pbx_configs" | "moh"; redact: boolean }> =
  CONFIG_FILE_TABLE;

export const CONFIG_FILE_NAMES = Object.keys(CONFIG_FILE_TABLE) as [ConfigFileName, ...ConfigFileName[]];

/**
 * Resolve an allowlisted config name to an absolute path.
 *
 * The containment check at the end is belt-and-braces: the name is already
 * constrained to the frozen key set above, so it cannot contain `..` today.
 * It is kept so that a future edit adding a plausible-looking entry to
 * CONFIG_FILES cannot quietly turn this into a traversal primitive.
 */
export function resolveConfigPath(name: ConfigFileName): string {
  const entry = CONFIG_FILES[name];
  if (!entry) throw new Error(`Unknown config file "${name}".`);

  const base = entry.dir === "moh" ? mohDir() : pbxConfigsDir();
  const resolved = path.resolve(base, name);
  if (resolved !== path.join(base, name)) {
    throw new Error(`Refusing to read "${name}": resolved outside its allowed directory.`);
  }
  return resolved;
}

export function shouldRedact(name: ConfigFileName): boolean {
  return CONFIG_FILES[name].redact;
}

// Matches Asterisk config assignments whose VALUE is a credential, in the
// `key = value` / `key=value` form these files use. Anchored per line with
// the `m` flag; the key list is what actually appears across pbx_configs/
// (`secret` in manager.conf and pjsip auth stanzas, `password` in PJSIP
// auth, `dbpass` in res_odbc.conf, `vmpassword`/PIN columns in voicemail).
const SECRET_ASSIGNMENT = /^(\s*(?:secret|password|dbpass|dbpassword|vmsecret|authpassword)\s*=\s*).*$/gim;

/**
 * Replace credential values with a placeholder, preserving the key and line
 * structure so the operator can still see THAT a secret is configured (and
 * on which line) without seeing what it is.
 */
export function redactSecrets(content: string): string {
  return content.replace(SECRET_ASSIGNMENT, "$1<redacted by mcp-server>");
}

// ---------------------------------------------------------------------------
// Docker containers
// ---------------------------------------------------------------------------

// Exactly the `container_name:` values in docker-compose.yml. An enum for
// the same reason as the AMI commands: `docker logs <anything>` and
// especially `docker restart <anything>` against an operator-supplied string
// is a much larger blast radius than this tool needs.
export const CONTAINERS = [
  "algo-asterisk",
  "algo-web",
  "algo-coturn",
  "algo-postgres",
  "algo-cdr-listener",
  "algo-openwa",
] as const;

export type ContainerName = (typeof CONTAINERS)[number];

export const CONTAINER_NAMES = CONTAINERS as unknown as [ContainerName, ...ContainerName[]];

export const MAX_LOG_LINES = 500;

export function isKnownContainer(name: string): name is ContainerName {
  return (CONTAINERS as readonly string[]).includes(name);
}

/** Clamp a requested tail length into [1, MAX_LOG_LINES]. Non-finite input
 *  falls back to a modest default rather than throwing — an LLM passing
 *  garbage here should get logs, not an error. */
export function clampLogLines(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return 100;
  return Math.max(1, Math.min(MAX_LOG_LINES, Math.floor(requested)));
}

/**
 * Build the argv for `docker logs`. Returned as an ARRAY and executed with
 * execFile (never exec + a template string), so nothing here is ever parsed
 * by a shell — defense in depth on top of the enum, since the enum alone
 * already makes injection impossible today and the argv form keeps it
 * impossible if the enum is ever loosened.
 */
export function dockerLogsArgs(container: ContainerName, lines: number): string[] {
  if (!isKnownContainer(container)) throw new Error(`Unknown container "${container}".`);
  return ["logs", "--tail", String(clampLogLines(lines)), container];
}

export function dockerRestartArgs(container: ContainerName): string[] {
  if (!isKnownContainer(container)) throw new Error(`Unknown container "${container}".`);
  return ["restart", container];
}
