import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { env } from "node:process";
const DEBUG = env.FOUNDRY_DEBUG === "true";
function getLogDir() {
    const root = env.FOUNDRY_ROOT || process.cwd();
    return join(root, "agentic-development", "runtime", "logs");
}
function getLogFile() {
    const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    return join(getLogDir(), `foundry-runtime-${date}.log`);
}
function writeEntry(entry) {
    try {
        const logDir = getLogDir();
        mkdirSync(logDir, { recursive: true });
        appendFileSync(getLogFile(), JSON.stringify(entry) + "\n", "utf8");
    }
    catch {
        // Ignore write errors — logging must never break the pipeline
    }
}
const KEY_EVENTS = new Set([
    "model_blacklisted",
    "model_call_started",
    "model_call_error",
    "model_call_success",
    "process_spawned",
    "process_timeout",
    "process_killed",
    "process_exited",
    "pipeline_start",
    "pipeline_end",
    "agent_start",
    "agent_end",
]);
export function rlog(event, payload, level = "INFO") {
    const isKeyEvent = KEY_EVENTS.has(event);
    if (!DEBUG && !isKeyEvent)
        return;
    const entry = {
        ts: new Date().toISOString(),
        level,
        event,
        ...payload,
    };
    writeEntry(entry);
}
export function rlogModelCall(agent, model, attempt, timeout) {
    const entry = {
        ts: new Date().toISOString(),
        level: "INFO",
        event: "model_call_started",
        agent,
        model,
        attempt,
        timeout,
    };
    // model_call_started is a key event — always write
    writeEntry(entry);
}
export function rlogModelResult(agent, model, exitCode, duration, blacklisted, reason) {
    const isError = exitCode !== 0;
    const event = isError ? "model_call_error" : "model_call_success";
    const level = exitCode === 0 ? "INFO" : exitCode === 124 ? "ERROR" : "WARN";
    const isKeyEvent = KEY_EVENTS.has(event);
    if (!DEBUG && !isKeyEvent)
        return;
    const entry = {
        ts: new Date().toISOString(),
        level,
        event,
        agent,
        model,
        exitCode,
        duration,
        blacklisted,
        ...(reason !== undefined ? { reason } : {}),
    };
    writeEntry(entry);
}
export function rlogProcess(event, agent, pid, details = {}) {
    const level = event === "process_spawned" || event === "process_exited" ? "INFO" : "WARN";
    writeEntry({
        ts: new Date().toISOString(),
        level,
        event,
        agent,
        pid,
        ...details,
    });
}
export function rlogBlacklist(model, ttlSeconds, reason, exitCode, duration) {
    // model_blacklisted is always a key event
    const entry = {
        ts: new Date().toISOString(),
        level: "WARN",
        event: "model_blacklisted",
        model,
        ttlSeconds,
        reason,
        exitCode,
        duration,
    };
    writeEntry(entry);
}
