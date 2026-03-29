import { existsSync, mkdirSync, renameSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { execSync, exec } from "node:child_process";
import { readState, writeState } from "./task-state.js";
export function claimTask(taskDir, workerId) {
    const state = readState(taskDir);
    if (state.status !== "pending")
        return false;
    state.status = "in_progress";
    state.worker_id = workerId;
    state.claimed_at = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    state.updated_at = state.claimed_at;
    writeState(taskDir, state);
    return true;
}
export function releaseTask(taskDir) {
    const state = readState(taskDir);
    if (state.status !== "in_progress")
        return;
    state.status = "pending";
    delete state.worker_id;
    delete state.claimed_at;
    state.updated_at = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    writeState(taskDir, state);
}
export function archiveTask(taskDir) {
    // 10.1: Archive guard — summary.md must exist and be non-empty
    const summaryPath = join(taskDir, "summary.md");
    if (!existsSync(summaryPath) || statSync(summaryPath).size === 0) {
        // Emit archive_blocked event to events.jsonl
        const eventsPath = join(taskDir, "events.jsonl");
        const ts = new Date().toISOString().replace(/\.\d+Z$/, "Z");
        const event = JSON.stringify({ timestamp: ts, type: "archive_blocked", message: "Cannot archive task: summary.md is empty or missing" });
        try {
            const { appendFileSync } = require("node:fs");
            appendFileSync(eventsPath, event + "\n", "utf-8");
        }
        catch { }
        throw new Error("Cannot archive task: summary.md is empty or missing");
    }
    const state = readState(taskDir);
    if (state.status === "in_progress") {
        const agents = Array.isArray(state.agents) ? state.agents : [];
        const currentAttempt = state.attempt ?? 1;
        const summarizerDone = agents.some((a) => a.agent?.includes("summarizer") && a.status === "done" && (a.attempt ?? 1) === currentAttempt);
        if (summarizerDone) {
            state.status = "completed";
            state.updated_at = new Date().toISOString().replace(/\.\d+Z$/, "Z");
            writeState(taskDir, state);
        }
        else {
            throw new Error("Cannot archive an in-progress task");
        }
    }
    const tasksRoot = dirname(taskDir);
    const slug = basename(taskDir);
    const now = new Date();
    const day = String(now.getDate()).padStart(2, "0");
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const year = now.getFullYear();
    const dateDir = `${day}-${month}-${year}`;
    const archiveBase = join(tasksRoot, "archives", dateDir);
    mkdirSync(archiveBase, { recursive: true });
    const dest = join(archiveBase, slug);
    renameSync(taskDir, dest);
    return dest;
}
export function findRepoRoot() {
    let dir = process.cwd();
    while (dir !== "/") {
        if (existsSync(join(dir, "agentic-development", "foundry")))
            return dir;
        dir = join(dir, "..");
    }
    return process.cwd();
}
/**
 * Run a shell command inside a named tmux session (non-blocking).
 * Returns the session name and attach command for the user.
 */
function runInTmux(sessionName, shellCmd, cwd) {
    // Kill old session if exists
    try {
        execSync(`tmux kill-session -t "${sessionName}" 2>/dev/null`, { stdio: "ignore" });
    }
    catch { }
    // Create new detached tmux session running the command
    try {
        execSync(`tmux new-session -d -s "${sessionName}" -c "${cwd}" "${shellCmd}"`, { cwd, stdio: "ignore" });
    }
    catch (e) {
        return {
            session: sessionName,
            attachCmd: "",
            message: `Failed to start tmux session: ${e.message}`,
        };
    }
    const attachCmd = `tmux attach -t ${sessionName}`;
    return {
        session: sessionName,
        attachCmd,
        message: `Started in tmux → ${attachCmd}`,
    };
}
/**
 * Run a quick command synchronously (for non-long-running ops like stop, retry).
 */
function runQuick(cmd, cwd) {
    try {
        const out = execSync(cmd, {
            cwd,
            timeout: 15_000,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
        }).trim();
        return { session: "", attachCmd: "", message: out || "Done" };
    }
    catch (e) {
        return { session: "", attachCmd: "", message: e.stderr?.trim() || e.message || "Failed" };
    }
}
// ── Worker count ────────────────────────────────────────────────
const MAX_WORKERS = 5;
function workerConfigFile(repoRoot) {
    return join(repoRoot, ".opencode", "pipeline", "monitor-workers");
}
export function getWorkerCount(repoRoot) {
    const file = workerConfigFile(repoRoot);
    if (!existsSync(file))
        return 1;
    try {
        const val = parseInt(readFileSync(file, "utf-8").trim(), 10);
        return val >= 1 && val <= MAX_WORKERS ? val : 1;
    }
    catch {
        return 1;
    }
}
export function setWorkerCount(repoRoot, count) {
    const clamped = Math.max(1, Math.min(MAX_WORKERS, count));
    const dir = dirname(workerConfigFile(repoRoot));
    mkdirSync(dir, { recursive: true });
    writeFileSync(workerConfigFile(repoRoot), String(clamped), "utf-8");
    return { session: "", attachCmd: "", message: `Максимальна кількість воркерів: ${clamped}` };
}
export function cycleWorkerCount(repoRoot) {
    const current = getWorkerCount(repoRoot);
    const next = current >= MAX_WORKERS ? 1 : current + 1;
    return setWorkerCount(repoRoot, next);
}
// ── Foundry actions ─────────────────────────────────────────────
function foundryPath(repoRoot) {
    return join(repoRoot, "agentic-development", "foundry");
}
/** Check if foundry headless is running (not just TUI or tmux session) */
export function isHeadlessRunning() {
    try {
        // Look for actual headless process: "foundry headless" or "foundry-batch"
        // Exclude tmux sessions (foundry-monitor, foundry-headless session names)
        const out = execSync("ps -eo pid,args | grep -E 'foundry (headless|batch)|foundry-batch' | grep -v grep | grep -v tmux | grep -v 'capture-pane'", { stdio: "pipe", encoding: "utf-8", timeout: 3000 }).trim();
        return out.length > 0;
    }
    catch {
        return false;
    }
}
/**
 * Start foundry headless workers.
 * If already running → increment worker count instead.
 */
export function startWorkers(repoRoot) {
    if (isHeadlessRunning()) {
        // Already running → bump workers +1
        const current = getWorkerCount(repoRoot);
        const next = Math.min(current + 1, MAX_WORKERS);
        setWorkerCount(repoRoot, next);
        return { session: "foundry-headless", attachCmd: "tmux attach -t foundry-headless", message: `Headless running, workers: ${current} → ${next}` };
    }
    const cmd = `"${foundryPath(repoRoot)}" headless`;
    return runInTmux("foundry-headless", cmd, repoRoot);
}
/**
 * Ensure headless is running. If not → start it.
 * Called by auto-watcher when todo tasks exist but no headless process.
 */
export function ensureHeadless(repoRoot) {
    if (isHeadlessRunning())
        return null;
    const cmd = `"${foundryPath(repoRoot)}" headless`;
    return runInTmux("foundry-headless", cmd, repoRoot);
}
export function stopWorkers(repoRoot) {
    return runQuick(`"${foundryPath(repoRoot)}" stop`, repoRoot);
}
export function retryFailed(repoRoot) {
    return runQuick(`"${foundryPath(repoRoot)}" retry`, repoRoot);
}
export function runAutotest(repoRoot, smoke) {
    const args = ["autotest", "5"];
    if (smoke)
        args.push("--smoke");
    args.push("--start");
    const cmd = `"${foundryPath(repoRoot)}" ${args.join(" ")}`;
    return runInTmux("foundry-autotest", cmd, repoRoot);
}
// ── Ultraworks actions ──────────────────────────────────────────
function ultraworksPath(repoRoot) {
    return join(repoRoot, "agentic-development", "ultraworks.sh");
}
export function ultraworksLaunch(repoRoot) {
    const cmd = `"${ultraworksPath(repoRoot)}" launch`;
    return runInTmux("ultraworks", cmd, repoRoot);
}
export function ultraworksAttach(repoRoot) {
    // Just return the attach command — session should already exist
    return {
        session: "ultraworks",
        attachCmd: "tmux attach -t ultraworks",
        message: "Attach → tmux attach -t ultraworks",
    };
}
export function ultraworksCleanup(repoRoot) {
    return runQuick(`"${ultraworksPath(repoRoot)}" cleanup`, repoRoot);
}
/** Read live process status — pure TypeScript, no bash/jq overhead */
export function getProcessStatus(repoRoot) {
    const empty = { workers: [], zombies: [], lock: null };
    try {
        return getProcessStatusNative(repoRoot);
    }
    catch {
        return empty;
    }
}
function getProcessStatusNative(repoRoot) {
    const workers = [];
    const zombies = [];
    let lock = null;
    // Check batch lock
    const lockfile = join(repoRoot, ".opencode", "pipeline", ".batch.lock");
    if (existsSync(lockfile)) {
        try {
            const pid = readFileSync(lockfile, "utf-8").trim();
            if (/^\d+$/.test(pid)) {
                let state = "unknown";
                let isZombie = false;
                const procStatus = `/proc/${pid}/status`;
                if (existsSync(procStatus)) {
                    const content = readFileSync(procStatus, "utf-8");
                    const m = content.match(/^State:\s+(\S)/m);
                    if (m) {
                        state = m[1];
                        isZombie = state === "Z";
                    }
                }
                lock = { pid: parseInt(pid), state, zombie: isZombie };
            }
        }
        catch { }
    }
    // Read active processes via ps (single call, parse in JS)
    try {
        const out = execSync("ps -eo pid,stat,etime,args", {
            encoding: "utf-8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"],
        });
        const logDir = join(repoRoot, "agentic-development", "runtime", "logs");
        for (const line of out.split("\n").slice(1)) {
            const trimmed = line.trim();
            if (!trimmed)
                continue;
            const parts = trimmed.match(/^\s*(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/);
            if (!parts)
                continue;
            const [, pidStr, stat, etime, args] = parts;
            if (!/foundry|opencode/.test(args))
                continue;
            const pid = parseInt(pidStr);
            const isZombie = stat.startsWith("Z");
            // Try to find log file for this worker
            let log = null;
            try {
                const logFiles = readdirSync(logDir).filter(f => f.includes(pidStr) || f.endsWith(".log"));
                if (logFiles.length > 0)
                    log = join(logDir, logFiles[logFiles.length - 1]);
            }
            catch { }
            const entry = { pid, stat, etime, args: args.slice(0, 80), zombie: isZombie, log };
            if (isZombie)
                zombies.push(entry);
            else
                workers.push(entry);
        }
    }
    catch { }
    return { workers, zombies, lock };
}
/** Async version — returns via callback to avoid blocking Ink render */
export function getProcessStatusAsync(repoRoot, cb) {
    const empty = { workers: [], zombies: [], lock: null };
    exec("ps -eo pid,stat,etime,args", { encoding: "utf-8", timeout: 3000 }, (err, out) => {
        if (err) {
            cb(empty);
            return;
        }
        try {
            const workers = [];
            const zombies = [];
            let lock = null;
            // Check batch lock
            const lockfile = join(repoRoot, ".opencode", "pipeline", ".batch.lock");
            if (existsSync(lockfile)) {
                try {
                    const pid = readFileSync(lockfile, "utf-8").trim();
                    if (/^\d+$/.test(pid)) {
                        let state = "unknown";
                        let isZombie = false;
                        const procStatus = `/proc/${pid}/status`;
                        if (existsSync(procStatus)) {
                            const content = readFileSync(procStatus, "utf-8");
                            const m = content.match(/^State:\s+(\S)/m);
                            if (m) {
                                state = m[1];
                                isZombie = state === "Z";
                            }
                        }
                        lock = { pid: parseInt(pid), state, zombie: isZombie };
                    }
                }
                catch { }
            }
            for (const line of out.split("\n").slice(1)) {
                const trimmed = line.trim();
                if (!trimmed)
                    continue;
                const parts = trimmed.match(/^\s*(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/);
                if (!parts)
                    continue;
                const [, pidStr, stat, etime, args] = parts;
                if (!/foundry|opencode/.test(args))
                    continue;
                const pid = parseInt(pidStr);
                const isZombie = stat.startsWith("Z");
                const entry = { pid, stat, etime, args: args.slice(0, 80), zombie: isZombie, log: null };
                if (isZombie)
                    zombies.push(entry);
                else
                    workers.push(entry);
            }
            cb({ workers, zombies, lock });
        }
        catch {
            cb(empty);
        }
    });
}
/** Clean zombie processes and stale batch lock */
export function cleanZombies(repoRoot) {
    let cleaned = 0;
    // Check and clean stale batch lock
    const lockfile = join(repoRoot, ".opencode", "pipeline", ".batch.lock");
    if (existsSync(lockfile)) {
        try {
            const lockPid = readFileSync(lockfile, "utf8").trim();
            if (lockPid) {
                const statusFile = `/proc/${lockPid}/status`;
                let pidAlive = false;
                let isZombie = false;
                if (existsSync(statusFile)) {
                    const statusContent = readFileSync(statusFile, "utf8");
                    const stateMatch = statusContent.match(/^State:\s+(\S)/m);
                    const state = stateMatch ? stateMatch[1] : "";
                    pidAlive = state !== "";
                    isZombie = state === "Z";
                }
                if (!pidAlive || isZombie) {
                    try {
                        const { unlinkSync } = require("node:fs");
                        unlinkSync(lockfile);
                        cleaned++;
                    }
                    catch { /* ignore */ }
                }
            }
        }
        catch { /* ignore */ }
    }
    return { session: "", attachCmd: "", message: `Cleaned: ${cleaned} zombie(s)/stale lock(s)` };
}
// ── Doctor diagnostics ──────────────────────────────────────────
/** Run u-doctor general diagnostics in tmux */
export function runDoctor(repoRoot) {
    const cmd = `opencode run --agent u-doctor "Diagnose current Foundry state. Check failed tasks, zombie processes, missing files, and stale locks. Create root cause report in agentic-development/doctor/"`;
    return runInTmux("foundry-doctor", cmd, repoRoot);
}
/** Run u-doctor diagnostics for a specific task */
export function runDoctorTask(repoRoot, taskSlug) {
    const cmd = `opencode run --agent u-doctor "Diagnose task '${taskSlug}'. Check its state.json, handoff.md, agent logs, and identify why it failed or got stuck. Create root cause report in agentic-development/doctor/"`;
    return runInTmux("foundry-doctor", cmd, repoRoot);
}
/** Tail last N lines of a log file */
export function tailLog(logPath, lines = 40) {
    try {
        const out = execSync(`tail -n ${lines} "${logPath}"`, {
            encoding: "utf-8",
            timeout: 3000,
            stdio: ["pipe", "pipe", "pipe"],
        });
        return out.split("\n");
    }
    catch {
        return ["(log not available)"];
    }
}
