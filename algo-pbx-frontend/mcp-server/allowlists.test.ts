import { describe, expect, it } from "vitest";
import {
  CONFIG_FILE_NAMES,
  clampLogLines,
  dockerLogsArgs,
  dockerRestartArgs,
  isKnownContainer,
  redactSecrets,
  resolveConfigPath,
} from "./allowlists";

describe("resolveConfigPath", () => {
  it("resolves every allowlisted name inside the configured directory", () => {
    for (const name of CONFIG_FILE_NAMES) {
      const resolved = resolveConfigPath(name);
      expect(resolved.endsWith(name)).toBe(true);
    }
  });
});

describe("redactSecrets", () => {
  it("redacts secret/password/dbpass lines but preserves everything else", () => {
    const input = ["[general]", "secret = topsecret123", "port = 5038", "password=hunter2", "bindaddr = 0.0.0.0"].join(
      "\n"
    );
    const out = redactSecrets(input);
    expect(out).not.toContain("topsecret123");
    expect(out).not.toContain("hunter2");
    expect(out).toContain("port = 5038");
    expect(out).toContain("bindaddr = 0.0.0.0");
    expect(out).toContain("secret = <redacted by mcp-server>");
  });
});

describe("docker argv builders", () => {
  it("rejects an unknown container name", () => {
    // @ts-expect-error deliberately invalid input
    expect(() => dockerLogsArgs("not-a-real-container", 50)).toThrow();
    // @ts-expect-error deliberately invalid input
    expect(() => dockerRestartArgs("rm -rf /")).toThrow();
  });

  it("builds a clean argv array for a known container", () => {
    expect(dockerLogsArgs("algo-asterisk", 50)).toEqual(["logs", "--tail", "50", "algo-asterisk"]);
    expect(dockerRestartArgs("algo-web")).toEqual(["restart", "algo-web"]);
  });

  it("clamps log line counts into range", () => {
    expect(clampLogLines(undefined)).toBe(100);
    expect(clampLogLines(-5)).toBe(1);
    expect(clampLogLines(1_000_000)).toBe(500);
  });

  it("isKnownContainer rejects arbitrary strings", () => {
    expect(isKnownContainer("algo-asterisk")).toBe(true);
    expect(isKnownContainer("evil; rm -rf /")).toBe(false);
  });
});
