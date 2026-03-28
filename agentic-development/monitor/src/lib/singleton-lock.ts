/**
 * singleton-lock.ts — PID-based lock file to prevent multiple instances.
 *
 * Used by TUI monitor and headless to ensure only one instance runs.
 * Stale locks (PID dead) are automatically cleaned up.
 */
import { existsSync, writeFileSync, readFileSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface LockResult {
  acquired: boolean;
  existingPid?: number;
  lockFile: string;
}

/**
 * Try to acquire a lock file. Returns { acquired: true } on success.
 * If another process holds the lock, returns { acquired: false, existingPid }.
 * Stale locks (PID dead or zombie) are cleaned up automatically.
 */
export function acquireLock(lockFile: string): LockResult {
  mkdirSync(dirname(lockFile), { recursive: true });

  if (existsSync(lockFile)) {
    try {
      const pidStr = readFileSync(lockFile, "utf8").trim();
      const pid = parseInt(pidStr, 10);

      if (pid > 0) {
        // Check if process is alive (and not zombie)
        if (existsSync(`/proc/${pid}`)) {
          let isZombie = false;
          try {
            const status = readFileSync(`/proc/${pid}/status`, "utf8");
            const m = status.match(/^State:\s+(\S)/m);
            if (m && m[1] === "Z") isZombie = true;
          } catch { /* can't read = not our process, treat as alive */ }

          if (!isZombie) {
            return { acquired: false, existingPid: pid, lockFile };
          }
        }
        // PID dead or zombie — stale lock
      }
      unlinkSync(lockFile);
    } catch {
      try { unlinkSync(lockFile); } catch { /* ignore */ }
    }
  }

  writeFileSync(lockFile, `${process.pid}\n`, "utf8");
  return { acquired: true, lockFile };
}

/**
 * Release a lock file. Safe to call multiple times.
 */
export function releaseLock(lockFile: string): void {
  try {
    // Only release if we own it
    if (existsSync(lockFile)) {
      const pidStr = readFileSync(lockFile, "utf8").trim();
      const pid = parseInt(pidStr, 10);
      if (pid === process.pid) {
        unlinkSync(lockFile);
      }
    }
  } catch { /* ignore */ }
}
