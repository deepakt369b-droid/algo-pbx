import { readFile } from "node:fs/promises";
import { resolveConfigPath, redactSecrets, shouldRedact, type ConfigFileName } from "./allowlists";

export async function readPbxConfig(name: ConfigFileName): Promise<string> {
  const path = resolveConfigPath(name);
  const content = await readFile(path, "utf8");
  return shouldRedact(name) ? redactSecrets(content) : content;
}
