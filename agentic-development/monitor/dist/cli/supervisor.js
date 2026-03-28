/**
 * Foundry Supervisor — autonomous task runner with health monitoring
 *
 * Launches a pipeline task, polls status on interval, auto-diagnoses failures,
 * retries up to N times, analyzes FAIL summaries, and writes fix proposals.
 */
import { parseArgs } from "node:util";
import { env } from "node:process";
import { join, basename } from "node:path";
import { existsSync, readFileSync, writeFileSync, statSync, readdirSync, } from "node:fs";
import { execSync } from "node:child_process";
import { readTaskState, setStateStatus, findTaskBySlug, slugify, } from "../state/task-state-v2.js";
import { parseEventLine } from "../state/events.js";
import { runPipeline } from "../pipeline/runner.js";
import { slugifyBranch } from "../infra/git.js";
import { initEventsLog } from "../state/events.js";
import { getProcessHealth, getRootCauseInfo } from "../lib/db-info.js";
// ── Config ────────────────────────────────────────────────────────
const REPO_ROOT = env.REPO_ROOT || process.cwd();
const TASKS_ROOT = env.PIPELINE_TASKS_ROOT || join(REPO_ROOT, "tasks");
const PROFILES = {
    "quick-fix": ["u-coder", "u-validator", "u-summarizer"],
    standard: ["u-architect", "u-coder", "u-validator", "u-tester", "u-summarizer"],
    complex: ["u-architect", "u-coder", "u-auditor", "u-validator", "u-tester", "u-summarizer"],
    bugfix: ["u-investigator", "u-coder", "u-validator", "u-tester", "u-summarizer"],
    "docs-only": ["u-documenter", "u-summarizer"],
};
/** Per-agent stall thresholds (seconds since last activity) */
const AGENT_STALL_THRESHOLD = {
    "u-planner": 600, // 10 min (timeout 900s)
    "u-investigator": 600,
    "u-architect": 900, // 15 min (timeout 2700s)
    "u-coder": 1200, // 20 min (timeout 3600s)
    "u-validator": 600,
    "u-tester": 600,
    "u-documenter": 600,
    "u-auditor": 600,
    "u-summarizer": 300, // 5 min
    "u-merger": 600,
};
const DEFAULT_STALL_SEC = 600;
const PENDING_STALL_SEC = 360; // 6 min stuck in pending
// ── Colours ───────────────────────────────────────────────────────
const c = {
    reset: "\x1b[0m",
    bold: "\x1b[1m",
    red: "\x1b[31m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
    cyan: "\x1b[36m",
};
const ts = () => new Date().toLocaleTimeString("en-GB", { hour12: false });
const log = (m) => console.log(`${c.cyan}[sv ${ts()}]${c.reset} ${m}`);
const ok = (m) => console.log(`${c.green}[sv ${ts()}] ✓${c.reset} ${m}`);
const warn = (m) => console.log(`${c.yellow}[sv ${ts()}] ⚠${c.reset} ${m}`);
const err = (m) => console.log(`${c.red}[sv ${ts()}] ✗${c.reset} ${m}`);
// ── Helpers ───────────────────────────────────────────────────────
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
function readJson(path) {
    try {
        return JSON.parse(readFileSync(path, "utf-8"));
    }
    catch {
        return null;
    }
}
function getLastEvents(taskDir, n = 5) {
    const eventsPath = join(taskDir, "events.jsonl");
    if (!existsSync(eventsPath))
        return [];
    try {
        const lines = readFileSync(eventsPath, "utf-8").trim().split("\n");
        return lines
            .slice(-n)
            .map((l) => {
            // Try pipe-delimited format first (emitEvent format)
            const piped = parseEventLine(l);
            if (piped)
                return piped;
            // Fallback: JSON format (task events written by bash/appendEvent)
            try {
                const json = JSON.parse(l);
                return {
                    ts: json.timestamp ?? "",
                    epoch: json.timestamp ? Math.floor(new Date(json.timestamp).getTime() / 1000) : 0,
                    type: json.type ?? "UNKNOWN",
                    details: { message: json.message ?? "", step: json.step ?? "" },
                };
            }
            catch {
                return null;
            }
        })
            .filter(Boolean);
    }
    catch {
        return [];
    }
}
function getSecondsSinceLastActivity(taskDir) {
    const now = Date.now();
    // Try events.jsonl last line timestamp
    const eventsPath = join(taskDir, "events.jsonl");
    if (existsSync(eventsPath)) {
        try {
            const lines = readFileSync(eventsPath, "utf-8").trim().split("\n");
            const last = lines[lines.length - 1];
            const parsed = JSON.parse(last);
            if (parsed.timestamp) {
                return Math.floor((now - new Date(parsed.timestamp).getTime()) / 1000);
            }
        }
        catch { }
    }
    // Fallback: state.json mtime
    const statePath = join(taskDir, "state.json");
    if (existsSync(statePath)) {
        return Math.floor((now - statSync(statePath).mtimeMs) / 1000);
    }
    return 0;
}
/** @internal exported for testing */
export function getTotalCost(state) {
    if (!state.agents)
        return 0;
    return Object.values(state.agents).reduce((sum, a) => sum + (a.cost ?? 0), 0);
}
/** @internal exported for testing */
export function getFailedAgents(state) {
    if (!state.agents)
        return [];
    return Object.entries(state.agents)
        .filter(([, a]) => a.status === "failed")
        .map(([name]) => name);
}
/** @internal exported for testing */
export function getSummaryStatus(taskDir) {
    const summaryPath = join(taskDir, "summary.md");
    if (!existsSync(summaryPath))
        return "NO_SUMMARY";
    try {
        const content = readFileSync(summaryPath, "utf-8");
        if (!content.trim())
            return "NO_SUMMARY";
        // Strip markdown bold markers before matching
        const plain = content.replace(/\*{1,2}/g, "");
        if (/(?:статус|status)\s*[:\-—]*\s*PASS/i.test(plain))
            return "PASS";
        if (/(?:статус|status)\s*[:\-—]*\s*FAIL/i.test(plain))
            return "FAIL";
        if (/completed successfully/i.test(plain))
            return "PASS";
        return "UNKNOWN";
    }
    catch {
        return "NO_SUMMARY";
    }
}
function getAgentLogTail(taskDir, agent, lines = 20) {
    const logDir = join(taskDir, "artifacts", agent);
    if (!existsSync(logDir))
        return [];
    try {
        const files = readdirSync(logDir)
            .filter((f) => f.endsWith(".log"))
            .sort();
        if (files.length === 0)
            return [];
        const content = readFileSync(join(logDir, files[files.length - 1]), "utf-8");
        return content.split("\n").slice(-lines);
    }
    catch {
        return [];
    }
}
function workersAlive() {
    try {
        execSync("pgrep -f foundry-batch", { stdio: "pipe" });
        return true;
    }
    catch {
        return false;
    }
}
function startWorkers() {
    try {
        execSync(`${join(REPO_ROOT, "agentic-development", "foundry")} headless`, { stdio: "inherit", timeout: 10_000 });
    }
    catch { }
}
function removeStaleLock(taskDir) {
    const lockPath = join(taskDir, ".claim.lock");
    if (!existsSync(lockPath))
        return false;
    try {
        const age = Math.floor((Date.now() - statSync(lockPath).mtimeMs) / 1000);
        if (age > 120) {
            const { unlinkSync } = require("node:fs");
            unlinkSync(lockPath);
            return true;
        }
    }
    catch { }
    return false;
}
/** @internal exported for testing */
export function diagnose(taskDir, state) {
    const events = getLastEvents(taskDir, 20);
    const evText = events.map((e) => `${e.type} ${e.details?.message ?? ""}`).join("\n");
    const failed = getFailedAgents(state);
    // Check patterns in events
    if (/timeout|exit.code.124|hard_timeout/i.test(evText)) {
        return { category: "timeout", action: "retry_with_split", detail: `Agent timeout: ${failed.join(", ")}` };
    }
    if (/rate.limit|429|503|model.*unavail/i.test(evText)) {
        return { category: "rate_limit", action: "wait_retry", detail: "Model rate-limited or unavailable" };
    }
    if (/merge|conflict|checkout/i.test(evText)) {
        return { category: "git_conflict", action: "manual", detail: "Git merge conflict" };
    }
    if (/zombie|stale.*lock/i.test(evText)) {
        return { category: "zombie", action: "clean_retry", detail: "Zombie process or stale lock" };
    }
    if (/preflight|stop_reason/i.test(evText)) {
        return { category: "preflight", action: "fix_env", detail: "Preflight check failed" };
    }
    // Enrich with DB root-cause analysis
    let dbDetail = "";
    try {
        const rca = getRootCauseInfo();
        if (rca.sessionId) {
            dbDetail = ` | DB: ${rca.possibleCause} (${rca.totalMessages} msgs, ${Math.round(rca.idleSeconds / 60)}m idle)`;
        }
    }
    catch { /* ignore */ }
    // Show agent log snippet for unknown failures
    if (failed.length > 0) {
        const logSnippet = getAgentLogTail(taskDir, failed[0], 5).join("\n");
        return {
            category: "agent_error",
            action: "retry",
            detail: `${failed.join(", ")} failed.\n  Last log: ${logSnippet.slice(0, 200)}${dbDetail}`,
        };
    }
    return { category: "unknown", action: "retry", detail: `No clear error pattern${dbDetail}` };
}
// ── Fix & Retry ───────────────────────────────────────────────────
async function applyFixAndRetry(taskDir, diag, attempt) {
    log(`Fix: ${diag.category} → ${diag.action} (attempt ${attempt})`);
    switch (diag.action) {
        case "wait_retry":
            log("Rate limit — waiting 60s...");
            await sleep(60_000);
            break;
        case "clean_retry":
            log("Cleaning stale locks...");
            removeStaleLock(taskDir);
            try {
                execSync(join(REPO_ROOT, "agentic-development", "foundry") + " stop", { stdio: "pipe" });
            }
            catch { }
            await sleep(5_000);
            break;
        case "fix_env":
            warn("Preflight failure — running setup...");
            try {
                execSync(join(REPO_ROOT, "agentic-development", "foundry") + " setup", { stdio: "pipe" });
            }
            catch { }
            break;
        case "retry_with_split":
            warn("Timeout — retrying (fallback models will be used)");
            break;
        case "manual":
            err("Manual intervention needed — cannot auto-fix");
            return false;
        case "retry":
            break;
    }
    // Reset task to pending
    const state = readTaskState(taskDir);
    if (state) {
        const newAttempt = (state.attempt ?? 1) + 1;
        setStateStatus(taskDir, "pending", undefined);
        // Update attempt
        const freshState = readTaskState(taskDir);
        if (freshState) {
            freshState.attempt = newAttempt;
            writeFileSync(join(taskDir, "state.json"), JSON.stringify(freshState, null, 2));
        }
    }
    // Append retry event to events.jsonl
    const event = JSON.stringify({
        timestamp: new Date().toISOString(),
        type: "supervisor_retry",
        message: `Auto-retry attempt ${attempt} (${diag.category})`,
        step: null,
    });
    try {
        const evPath = join(taskDir, "events.jsonl");
        const { appendFileSync } = require("node:fs");
        appendFileSync(evPath, event + "\n");
    }
    catch { }
    // Ensure workers are running
    if (!workersAlive()) {
        log("Starting headless workers...");
        startWorkers();
        await sleep(5_000);
    }
    const updatedState = readTaskState(taskDir);
    ok(`Task reset to pending (attempt ${updatedState?.attempt ?? 1})`);
    return true;
}
// ── Root-Cause Report ─────────────────────────────────────────────
function writeRootCauseReport(taskDir, state) {
    // Determine next N: count existing root-cause-*.md files
    let n = 0;
    try {
        const files = readdirSync(taskDir).filter((f) => /^root-cause-\d+\.md$/.test(f));
        n = files.length;
    }
    catch { /* ignore */ }
    const fileName = `root-cause-${n}.md`;
    const filePath = join(taskDir, fileName);
    const failed = getFailedAgents(state);
    const events = getLastEvents(taskDir, 10);
    // Gather DB info
    let rca = null;
    try {
        rca = getRootCauseInfo();
    }
    catch { /* ignore */ }
    const lines = [
        `# Root Cause — Crash ${n}`,
        "",
        `**Time:** ${new Date().toISOString()}`,
        `**Failed agent:** ${failed.join(", ") || "unknown"}`,
        `**Attempt:** ${state.attempt ?? 1}`,
        `**Status:** ${state.status}`,
    ];
    if (rca?.sessionId) {
        lines.push(`**Session:** ${rca.sessionId}`);
        lines.push(`**Model:** ${rca.lastModel ?? "unknown"}`);
        lines.push(`**Idle:** ${rca.idleSeconds}s since last DB activity`);
        lines.push(`**Messages:** ${rca.totalMessages}`);
    }
    lines.push("");
    lines.push("## Possible Cause");
    lines.push(rca?.possibleCause ?? "Could not determine (DB unavailable)");
    // Events
    lines.push("");
    lines.push("## Events (last 10)");
    if (events.length > 0) {
        for (const e of events) {
            lines.push(`- \`${e.type}\` ${e.details?.message ?? ""} ${e.details?.step ?? ""}`);
        }
    }
    else {
        lines.push("_No events found_");
    }
    // Last messages from DB
    if (rca?.lastMessages && rca.lastMessages.length > 0) {
        lines.push("");
        lines.push("## Last Messages (from DB)");
        lines.push("| Role | Model | Input | Output | Cache Read |");
        lines.push("|------|-------|------:|-------:|-----------:|");
        for (const msg of rca.lastMessages) {
            lines.push(`| ${msg.role} | ${msg.provider}/${msg.model} | ${msg.inputTokens} | ${msg.outputTokens} | ${msg.cacheRead} |`);
        }
    }
    // Agent log tail
    if (failed.length > 0) {
        lines.push("");
        lines.push("## Agent Log Tail");
        const logTail = getAgentLogTail(taskDir, failed[0], 20);
        if (logTail.length > 0) {
            lines.push("```");
            lines.push(...logTail);
            lines.push("```");
        }
        else {
            lines.push("_No log available_");
        }
    }
    // Cache stats
    if (rca?.cacheStats && rca.cacheStats.length > 0) {
        lines.push("");
        lines.push("## Cache Stats");
        lines.push("| Model | Msgs | Cache Hit % | Avg Input |");
        lines.push("|-------|-----:|------------:|----------:|");
        for (const stat of rca.cacheStats) {
            lines.push(`| ${stat.model} | ${stat.messages} | ${stat.cache_hit_pct}% | ${stat.avg_input} |`);
        }
    }
    const content = lines.join("\n") + "\n";
    writeFileSync(filePath, content, "utf-8");
    log(`Root-cause report saved: ${fileName}`);
    return filePath;
}
// ── FAIL Summary Analysis ─────────────────────────────────────────
function analyzeFail(taskDir, state) {
    const summaryPath = join(taskDir, "summary.md");
    const summary = existsSync(summaryPath) ? readFileSync(summaryPath, "utf-8") : "";
    const failed = getFailedAgents(state);
    // Extract key sections
    const diffSection = (header) => {
        const m = summary.match(new RegExp(`${header.source}[\\s\\S]*?(?=\\n## |$)`, "i"));
        return m ? m[0].trim() : "";
    };
    const difficulties = diffSection(/## (?:Труднощі|Difficulties)/);
    const recommendations = diffSection(/## (?:Рекомендації|Recommendations)/);
    const proposals = [];
    if (/phpstan|static.analysis|type.error/i.test(summary)) {
        proposals.push("PHPStan errors → foundry run --only u-validator \"Fix PHPStan\"");
    }
    if (/test.*fail|e2e.*fail|assertion/i.test(summary)) {
        proposals.push("Test failures → foundry run --only u-tester \"Fix tests\"");
    }
    if (/timeout|took too long/i.test(summary)) {
        proposals.push("Timeouts → split task or use --profile quick-fix");
    }
    if (/conflict|merge/i.test(summary)) {
        proposals.push(`Git conflict → resolve on branch ${state.branch ?? "?"}`);
    }
    // Write fix-proposal.md
    const slug = basename(taskDir).replace(/--foundry$/, "");
    const proposalContent = [
        "# Fix Proposal",
        "",
        `**Generated:** ${new Date().toISOString()}`,
        `**Task:** ${basename(taskDir)}`,
        `**Status:** FAIL`,
        `**Failed agents:** ${failed.join(", ") || "none"}`,
        "",
        difficulties ? `## Difficulties\n\n${difficulties}\n` : "",
        recommendations ? `## Recommendations\n\n${recommendations}\n` : "",
        "## Proposals",
        "",
        ...proposals.map((p, i) => `${i + 1}. ${p}`),
        "",
        "## Next Steps",
        "",
        `1. Review: cat ${taskDir}/summary.md`,
        `2. Logs: ls ${taskDir}/artifacts/*/`,
        `3. Retry: foundry retry ${slug}`,
        `4. Targeted fix: foundry run "Fix: <specific issue>"`,
    ]
        .filter(Boolean)
        .join("\n");
    writeFileSync(join(taskDir, "fix-proposal.md"), proposalContent);
    return proposalContent;
}
/** @internal exported for testing */
export function checkStall(taskDir, status, step) {
    const idleSec = getSecondsSinceLastActivity(taskDir);
    let threshold;
    if (status === "pending") {
        threshold = PENDING_STALL_SEC;
    }
    else if (step && step in AGENT_STALL_THRESHOLD) {
        threshold = AGENT_STALL_THRESHOLD[step];
    }
    else {
        threshold = DEFAULT_STALL_SEC;
    }
    // Enrich with DB-based health check when status is in_progress
    let dbHealth = null;
    if (status === "in_progress") {
        try {
            dbHealth = getProcessHealth(taskDir, threshold);
        }
        catch { /* ignore DB errors */ }
    }
    // Combine: stalled if file-based idle exceeds threshold,
    // OR if DB says session is stale AND PID is dead
    const fileStalled = idleSec > threshold;
    const dbStalled = dbHealth
        ? (!dbHealth.alive && !dbHealth.pidAlive)
        : false;
    return {
        stalled: fileStalled || dbStalled,
        idleSec,
        threshold,
        dbHealth,
    };
}
export async function cmdSupervisor(args) {
    const { values, positionals } = parseArgs({
        args,
        options: {
            slug: { type: "string" },
            profile: { type: "string", short: "p", default: "standard" },
            poll: { type: "string", default: "180" },
            retries: { type: "string", default: "3" },
        },
        allowPositionals: true,
    });
    const opts = {
        taskMessage: positionals.join(" ").trim() || undefined,
        slug: values.slug,
        profile: values.profile || "standard",
        pollSec: parseInt(values.poll, 10) || 180,
        maxRetries: parseInt(values.retries, 10) || 3,
    };
    if (!opts.taskMessage && !opts.slug) {
        console.error("Usage: foundry supervisor \"task description\" [--profile standard] [--poll 180] [--retries 3]");
        console.error("       foundry supervisor --slug <existing-slug>");
        return 1;
    }
    console.log(`\n${c.bold}╔══════════════════════════════════════════╗${c.reset}`);
    console.log(`${c.bold}║     Foundry Supervisor — Autonomous      ║${c.reset}`);
    console.log(`${c.bold}╚══════════════════════════════════════════╝${c.reset}\n`);
    // ── Step 1: Find or create task ─────────────────────────────────
    let taskDir;
    if (opts.slug) {
        const found = findTaskBySlug(opts.slug);
        if (!found) {
            err(`Task not found: ${opts.slug}`);
            return 1;
        }
        taskDir = found;
        log(`Found: ${basename(taskDir)}`);
    }
    else {
        const msg = opts.taskMessage;
        const profile = opts.profile;
        const agents = [...(PROFILES[profile] || PROFILES.standard)];
        const branch = `pipeline/${slugifyBranch(msg)}`;
        const taskSlug = slugify(msg);
        taskDir = join(TASKS_ROOT, `${taskSlug}--foundry`);
        log(`Launching: ${msg.slice(0, 80)}…`);
        log(`Profile: ${profile} | Agents: ${agents.join(" → ")}`);
        // Run pipeline in background
        const config = {
            repoRoot: REPO_ROOT,
            taskDir,
            taskMessage: msg,
            branch,
            profile,
            agents,
            skipPlanner: false,
            skipEnvCheck: false,
            audit: false,
            noCommit: false,
            telegram: false,
        };
        if (!existsSync(taskDir)) {
            const { mkdirSync } = require("node:fs");
            mkdirSync(taskDir, { recursive: true });
        }
        initEventsLog(join(REPO_ROOT, ".opencode/pipeline"));
        // Launch pipeline — don't await, we'll monitor via state.json
        const pipelinePromise = runPipeline(config).catch((e) => {
            err(`Pipeline crashed: ${e}`);
            return null;
        });
        // Give it a moment to initialise
        await sleep(3_000);
        ok(`Task created: ${basename(taskDir)}`);
        // We don't await pipelinePromise — the monitor loop takes over.
        // But we do keep a reference so the process doesn't exit early.
        pipelinePromise.then(() => {
            log("Pipeline process finished");
        });
    }
    log(`Poll: ${opts.pollSec}s | Max retries: ${opts.maxRetries}`);
    log(`Dir: ${taskDir}\n`);
    // ── Step 2: Monitor loop ────────────────────────────────────────
    let retryCount = 0;
    for (;;) {
        const state = readTaskState(taskDir);
        if (!state) {
            warn("No state.json yet — waiting…");
            await sleep(opts.pollSec * 1000);
            continue;
        }
        const status = state.status;
        const step = state.current_step ?? null;
        const cost = getTotalCost(state);
        const attempt = state.attempt ?? 1;
        const stall = checkStall(taskDir, status, step);
        switch (status) {
            // ── Pending ────────────────────────────────────────────
            case "pending": {
                log(`⏳ Pending (attempt ${attempt}) | idle ${stall.idleSec}s`);
                if (stall.stalled) {
                    warn(`Stuck in pending for ${Math.round(stall.idleSec / 60)} min`);
                    if (!workersAlive()) {
                        warn("No workers — starting headless…");
                        startWorkers();
                    }
                    else {
                        const removed = removeStaleLock(taskDir);
                        if (removed)
                            warn("Removed stale claim lock");
                    }
                }
                break;
            }
            // ── In Progress ────────────────────────────────────────
            case "in_progress": {
                const dbInfo = stall.dbHealth;
                const modelStr = dbInfo?.lastModel ? ` | ${dbInfo.lastModel}` : "";
                const msgStr = dbInfo?.messageCount ? ` | ${dbInfo.messageCount} msgs` : "";
                log(`🔄 ${step ?? "?"} | $${cost.toFixed(2)} | attempt ${attempt} | idle ${stall.idleSec}s${modelStr}${msgStr}`);
                if (stall.stalled) {
                    warn(`STALL: ${step ?? "?"} no activity for ${Math.round(stall.idleSec / 60)} min (threshold ${Math.round(stall.threshold / 60)} min)`);
                    // DB-enriched diagnostics
                    if (dbInfo) {
                        if (dbInfo.pid && !dbInfo.pidAlive) {
                            warn(`PID ${dbInfo.pid} is dead (zombie or crashed) — resetting to pending`);
                            removeStaleLock(taskDir);
                            setStateStatus(taskDir, "pending", undefined);
                            startWorkers();
                            break;
                        }
                        if (!dbInfo.alive) {
                            warn(`DB session stale (${Math.round(dbInfo.idleSeconds / 60)} min idle in DB)`);
                        }
                    }
                    const lastEvents = getLastEvents(taskDir, 3);
                    for (const e of lastEvents) {
                        console.log(`  ${e.type}: ${e.details?.message ?? ""}`);
                    }
                    // Fallback: check if worker is alive
                    if (state.worker_id && !workersAlive()) {
                        warn("Worker appears dead — resetting to pending");
                        removeStaleLock(taskDir);
                        setStateStatus(taskDir, "pending", undefined);
                        startWorkers();
                    }
                }
                break;
            }
            // ── Waiting Answer (HITL) ──────────────────────────────
            case "waiting_answer": {
                warn(`⏸  HITL — ${state.waiting_agent ?? "agent"} needs input`);
                const qaPath = join(taskDir, "qa.json");
                if (existsSync(qaPath)) {
                    const qa = readJson(qaPath);
                    if (qa?.questions) {
                        for (const q of qa.questions) {
                            if (!q.answer) {
                                console.log(`  [${q.priority}] ${q.agent}: ${q.question}`);
                            }
                        }
                    }
                }
                log("Answer via monitor or: foundry monitor → Enter on task");
                break;
            }
            // ── Completed ──────────────────────────────────────────
            case "completed": {
                const summaryStatus = getSummaryStatus(taskDir);
                if (summaryStatus === "PASS" || summaryStatus === "UNKNOWN") {
                    const summaryPath = join(taskDir, "summary.md");
                    if (existsSync(summaryPath)) {
                        console.log();
                        ok("Task completed successfully!");
                        ok(`Cost: $${cost.toFixed(2)} | Attempt: ${attempt}`);
                        console.log(`\n${c.bold}═══ Summary ═══${c.reset}`);
                        console.log(readFileSync(summaryPath, "utf-8"));
                        return 0;
                    }
                    // No summary file yet — wait a tick
                    warn("Completed but no summary.md — waiting…");
                    await sleep(10_000);
                    if (existsSync(summaryPath)) {
                        ok("Summary appeared!");
                        console.log(readFileSync(summaryPath, "utf-8"));
                        return 0;
                    }
                    break;
                }
                if (summaryStatus === "FAIL") {
                    warn("Task completed but summary = FAIL");
                    writeRootCauseReport(taskDir, state);
                    const proposal = analyzeFail(taskDir, state);
                    console.log(proposal);
                    retryCount++;
                    if (retryCount <= opts.maxRetries) {
                        log(`Auto-retry ${retryCount}/${opts.maxRetries} after FAIL summary…`);
                        const diag = { category: "summary_fail", action: "retry", detail: "Summary FAIL" };
                        const ok = await applyFixAndRetry(taskDir, diag, retryCount);
                        if (!ok) {
                            err("Cannot auto-fix. See fix-proposal.md");
                            return 1;
                        }
                    }
                    else {
                        err(`Max retries (${opts.maxRetries}) reached with FAIL summary`);
                        err(`See: ${join(taskDir, "fix-proposal.md")}`);
                        return 1;
                    }
                }
                if (summaryStatus === "NO_SUMMARY") {
                    warn("Completed but no summary.md — waiting…");
                }
                break;
            }
            // ── Failed / Stopped ───────────────────────────────────
            case "failed":
            case "stopped": {
                warn(`Task ${status} at step: ${step ?? "?"}`);
                // Always write root-cause report before retry
                writeRootCauseReport(taskDir, state);
                retryCount++;
                if (retryCount > opts.maxRetries) {
                    err(`Max retries (${opts.maxRetries}) exhausted`);
                    err(`Status: ${status} | Cost: $${cost.toFixed(2)} | Attempts: ${attempt}`);
                    if (existsSync(join(taskDir, "summary.md"))) {
                        analyzeFail(taskDir, state);
                    }
                    return 1;
                }
                const diag = diagnose(taskDir, state);
                warn(`Diagnosis: ${diag.category} — ${diag.detail.slice(0, 120)}`);
                const fixed = await applyFixAndRetry(taskDir, diag, retryCount);
                if (!fixed) {
                    err(`Cannot auto-fix (${diag.category}). Manual intervention required.`);
                    return 1;
                }
                break;
            }
            // ── Suspended ──────────────────────────────────────────
            case "suspended": {
                warn("Task suspended — needs manual review");
                const slug = basename(taskDir).replace(/--foundry$/, "");
                log(`Resume: foundry resume ${slug}`);
                break;
            }
            default:
                warn(`Unknown status: ${status}`);
        }
        await sleep(opts.pollSec * 1000);
    }
}
