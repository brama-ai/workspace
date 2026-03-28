/**
 * Tests for singleton-lock.ts — PID-based lock file.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createTestRoot } from "./helpers/fixtures.js";
import { acquireLock, releaseLock } from "../lib/singleton-lock.js";

describe("singleton-lock", () => {
  let root: string;
  let lockFile: string;

  beforeEach(() => {
    root = createTestRoot("lock-");
    lockFile = join(root, "test.lock");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe("acquireLock", () => {
    it("acquires lock when no lock file exists", () => {
      const result = acquireLock(lockFile);
      expect(result.acquired).toBe(true);
      expect(existsSync(lockFile)).toBe(true);

      const pid = parseInt(readFileSync(lockFile, "utf8").trim(), 10);
      expect(pid).toBe(process.pid);
    });

    it("fails when lock held by current process (re-acquire)", () => {
      const first = acquireLock(lockFile);
      expect(first.acquired).toBe(true);

      const second = acquireLock(lockFile);
      expect(second.acquired).toBe(false);
      expect(second.existingPid).toBe(process.pid);
    });

    it("cleans up stale lock (dead PID)", () => {
      // Write a lock with a PID that definitely doesn't exist
      writeFileSync(lockFile, "999999999\n", "utf8");

      const result = acquireLock(lockFile);
      expect(result.acquired).toBe(true);

      // Lock should now contain our PID
      const pid = parseInt(readFileSync(lockFile, "utf8").trim(), 10);
      expect(pid).toBe(process.pid);
    });

    it("cleans up corrupt lock file", () => {
      writeFileSync(lockFile, "not-a-pid\n", "utf8");

      const result = acquireLock(lockFile);
      expect(result.acquired).toBe(true);
    });

    it("creates parent directories if needed", () => {
      const deepLock = join(root, "deep", "nested", "dir", "test.lock");
      const result = acquireLock(deepLock);
      expect(result.acquired).toBe(true);
      expect(existsSync(deepLock)).toBe(true);
    });

    it("fails when lock held by alive process (PID 1 = init)", () => {
      // PID 1 is always alive on Linux
      writeFileSync(lockFile, "1\n", "utf8");

      const result = acquireLock(lockFile);
      expect(result.acquired).toBe(false);
      expect(result.existingPid).toBe(1);
    });
  });

  describe("releaseLock", () => {
    it("releases lock owned by current process", () => {
      acquireLock(lockFile);
      expect(existsSync(lockFile)).toBe(true);

      releaseLock(lockFile);
      expect(existsSync(lockFile)).toBe(false);
    });

    it("does not release lock owned by another PID", () => {
      writeFileSync(lockFile, "1\n", "utf8");

      releaseLock(lockFile);
      // Should NOT delete — not our lock
      expect(existsSync(lockFile)).toBe(true);
    });

    it("is safe to call when no lock exists", () => {
      // Should not throw
      releaseLock(lockFile);
      expect(existsSync(lockFile)).toBe(false);
    });

    it("is safe to call multiple times", () => {
      acquireLock(lockFile);
      releaseLock(lockFile);
      releaseLock(lockFile);
      releaseLock(lockFile);
      expect(existsSync(lockFile)).toBe(false);
    });
  });
});
