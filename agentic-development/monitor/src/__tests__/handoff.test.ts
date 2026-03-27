import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readHandoff,
  writeHandoff,
  appendHandoff,
  updateSection,
  readSection,
  extractFiles,
  extractBranch,
  initHandoff,
  summarizeHandoff,
} from "../pipeline/handoff.js";

describe("handoff", () => {
  let testDir: string;
  let handoffFile: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `handoff-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    handoffFile = join(testDir, "handoff.md");
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe("readHandoff / writeHandoff", () => {
    it("returns empty string for missing file", () => {
      expect(readHandoff(handoffFile)).toBe("");
    });

    it("writes and reads content", () => {
      writeHandoff(handoffFile, "# Test\n\nHello world");
      expect(readHandoff(handoffFile)).toBe("# Test\n\nHello world");
    });
  });

  describe("appendHandoff", () => {
    it("appends section to file", () => {
      writeHandoff(handoffFile, "# Pipeline");
      appendHandoff(handoffFile, "Coder", "Files changed:\n- src/foo.ts");
      
      const content = readHandoff(handoffFile);
      expect(content).toContain("## Coder");
      expect(content).toContain("src/foo.ts");
      expect(content).toContain("Updated:");
    });
  });

  describe("readSection", () => {
    it("reads specific section", () => {
      writeHandoff(handoffFile, `# Pipeline

## Coder

Changed foo.ts

## Validator

PHPStan passed
`);
      const section = readSection(handoffFile, "Coder");
      expect(section).toContain("Changed foo.ts");
    });

    it("returns null for missing section", () => {
      writeHandoff(handoffFile, "# Pipeline\n\n## Coder\n\nDone");
      expect(readSection(handoffFile, "Tester")).toBeNull();
    });
  });

  describe("extractFiles", () => {
    it("extracts file paths from content", () => {
      writeHandoff(handoffFile, `## Coder

file: \`src/foo.ts\`
path: \`src/bar.ts\`
changed: src/baz.ts
`);
      const files = extractFiles(handoffFile);
      expect(files.length).toBeGreaterThan(0);
      expect(files).toContain("src/foo.ts");
    });

    it("returns empty for no files", () => {
      writeHandoff(handoffFile, "No files here");
      expect(extractFiles(handoffFile)).toEqual([]);
    });
  });

  describe("extractBranch", () => {
    it("extracts branch name", () => {
      writeHandoff(handoffFile, "branch: `feature/my-branch`\n");
      expect(extractBranch(handoffFile)).toBe("feature/my-branch");
    });

    it("returns null when no branch", () => {
      writeHandoff(handoffFile, "No branch info");
      expect(extractBranch(handoffFile)).toBeNull();
    });
  });

  describe("initHandoff", () => {
    it("creates handoff with template", () => {
      // Set PIPELINE_DIR to testDir to avoid symlink to real .opencode/pipeline/
      process.env.PIPELINE_DIR = testDir;
      const file = initHandoff(testDir, "Add feature X", "pipeline/add-feature-x");
      expect(existsSync(file)).toBe(true);
      
      const content = readFileSync(file, "utf8");
      expect(content).toContain("Add feature X");
      expect(content).toContain("pipeline/add-feature-x");
      delete process.env.PIPELINE_DIR;
    });
  });

  describe("summarizeHandoff", () => {
    it("summarizes sections and files", () => {
      writeHandoff(handoffFile, `# Pipeline

## Coder

file: \`src/foo.ts\`
branch: \`my-branch\`

## Validator

All passed
`);
      const summary = summarizeHandoff(handoffFile);
      expect(summary.sections).toContain("Coder");
      expect(summary.sections).toContain("Validator");
      expect(summary.files).toContain("src/foo.ts");
      expect(summary.branch).toBe("my-branch");
    });
  });
});
