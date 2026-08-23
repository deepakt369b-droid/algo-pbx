import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dockerLogsArgs, dockerRestartArgs, type ContainerName } from "./allowlists";

const execFileAsync = promisify(execFile);

// execFile with an argv array, never a shell string — even though
// ContainerName is already constrained to a fixed enum (see allowlists.ts),
// this is defense in depth: if that enum is ever loosened, execFile alone
// (no shell interpolation) still prevents command injection through the
// container name.

export async function tailContainerLogs(container: ContainerName, lines: number): Promise<string> {
  const args = dockerLogsArgs(container, lines);
  const { stdout, stderr } = await execFileAsync("docker", args, { maxBuffer: 10 * 1024 * 1024 });
  return (stdout + stderr).trim() || "(no output)";
}

export async function restartContainer(container: ContainerName): Promise<string> {
  const args = dockerRestartArgs(container);
  const { stdout, stderr } = await execFileAsync("docker", args, { timeout: 30_000 });
  return (stdout + stderr).trim() || `${container} restarted`;
}
