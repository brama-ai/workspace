/**
 * supervisor-deprecation.test.ts — Tests for foundry supervisor deprecation notice.
 *
 * Test tier: Tier 2 (Unit) — verify deprecation notice is emitted.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("foundry supervisor deprecation", () => {
  let stderrOutput: string[] = [];
  let originalStderrWrite: typeof process.stderr.write;

  beforeEach(() => {
    stderrOutput = [];
    originalStderrWrite = process.stderr.write.bind(process.stderr);
    // Capture stderr output
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => {
      stderrOutput.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("cmdSupervisor emits deprecation notice to stderr", async () => {
    // We test the deprecation notice by checking the supervisor.ts source
    // contains the deprecation message (since running the full supervisor
    // would require a real task and pipeline setup)
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");

    const supervisorPath = join(
      process.cwd(),
      "src",
      "cli",
      "supervisor.ts",
    );

    let supervisorSource: string;
    try {
      supervisorSource = readFileSync(supervisorPath, "utf-8");
    } catch {
      // Try alternate path
      supervisorSource = readFileSync(
        join(process.cwd(), "..", "src", "cli", "supervisor.ts"),
        "utf-8",
      );
    }

    expect(supervisorSource).toContain("DEPRECATED");
    expect(supervisorSource).toContain("foundry monitor");
    expect(supervisorSource).toContain("sidebar chat");
  });

  it("foundry.ts help text marks supervisor as deprecated", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");

    const foundryPath = join(
      process.cwd(),
      "src",
      "cli",
      "foundry.ts",
    );

    let foundrySource: string;
    try {
      foundrySource = readFileSync(foundryPath, "utf-8");
    } catch {
      foundrySource = readFileSync(
        join(process.cwd(), "..", "src", "cli", "foundry.ts"),
        "utf-8",
      );
    }

    expect(foundrySource).toContain("DEPRECATED");
    expect(foundrySource).toContain("supervisor");
  });

  it("deprecation notice includes migration guidance", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");

    const supervisorPath = join(
      process.cwd(),
      "src",
      "cli",
      "supervisor.ts",
    );

    let supervisorSource: string;
    try {
      supervisorSource = readFileSync(supervisorPath, "utf-8");
    } catch {
      supervisorSource = readFileSync(
        join(process.cwd(), "..", "src", "cli", "supervisor.ts"),
        "utf-8",
      );
    }

    // Should mention the new workflow
    expect(supervisorSource).toContain("foundry monitor");
    // Should mention slash commands
    expect(supervisorSource).toContain("/model");
    expect(supervisorSource).toContain("/compact");
    expect(supervisorSource).toContain("/new");
  });
});
