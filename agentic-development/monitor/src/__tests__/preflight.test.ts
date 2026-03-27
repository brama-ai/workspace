import { describe, it, expect } from "vitest";
import {
  runPreflight,
  runEnvCheck,
  checkWorkspaceClean,
  checkBranch,
  renderPreflightReport,
  renderEnvCheckReport,
} from "../infra/preflight.js";

describe("preflight", () => {
  const repoRoot = process.cwd();

  describe("runPreflight", () => {
    it("returns result with checks array", () => {
      const result = runPreflight(repoRoot);
      expect(result.checks).toBeDefined();
      expect(Array.isArray(result.checks)).toBe(true);
      expect(result.checks.length).toBeGreaterThan(0);
    });

    it("checks for git", () => {
      const result = runPreflight(repoRoot);
      const gitCheck = result.checks.find(c => c.name === "git");
      expect(gitCheck).toBeDefined();
      expect(gitCheck!.passed).toBe(true);
    });

    it("checks for node", () => {
      const result = runPreflight(repoRoot);
      const nodeCheck = result.checks.find(c => c.name === "node");
      expect(nodeCheck).toBeDefined();
      expect(nodeCheck!.passed).toBe(true);
    });

    it("checks for jq", () => {
      const result = runPreflight(repoRoot);
      const jqCheck = result.checks.find(c => c.name === "jq");
      expect(jqCheck).toBeDefined();
      expect(jqCheck!.passed).toBe(true);
    });
  });

  describe("runEnvCheck", () => {
    it("returns checks with categories", () => {
      const result = runEnvCheck(repoRoot, "docs-only");
      expect(result.checks).toBeDefined();
      
      const categories = new Set(result.checks.map(c => c.category));
      expect(categories.has("node")).toBe(true);
    });

    it("marks non-required checks for docs-only", () => {
      const result = runEnvCheck(repoRoot, "docs-only");
      const phpCheck = result.checks.find(c => c.name === "php");
      expect(phpCheck).toBeDefined();
      expect(phpCheck!.required).toBe(false);
    });
  });

  describe("checkWorkspaceClean", () => {
    it("returns clean status and changes", () => {
      const result = checkWorkspaceClean(repoRoot);
      expect(typeof result.clean).toBe("boolean");
      expect(Array.isArray(result.changes)).toBe(true);
    });
  });

  describe("checkBranch", () => {
    it("returns current branch name", () => {
      const result = checkBranch(repoRoot);
      expect(result.branch).toBeDefined();
      expect(typeof result.branch).toBe("string");
      expect(typeof result.main).toBe("boolean");
    });
  });

  describe("renderPreflightReport", () => {
    it("renders markdown report", () => {
      const result = runPreflight(repoRoot);
      const report = renderPreflightReport(result);
      expect(report).toContain("# Preflight Check");
      expect(report).toContain("| Check |");
    });
  });

  describe("renderEnvCheckReport", () => {
    it("renders environment report", () => {
      const result = runEnvCheck(repoRoot, "standard");
      const report = renderEnvCheckReport(result);
      expect(report).toContain("# Environment Check");
      expect(report).toContain("| Category |");
    });
  });
});
