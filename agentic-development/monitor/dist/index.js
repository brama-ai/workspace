#!/usr/bin/env node
import { jsx as _jsx } from "react/jsx-runtime";
import { render } from "ink";
import { join } from "node:path";
import { App } from "./components/App.js";
import { acquireLock, releaseLock } from "./lib/singleton-lock.js";
const LOCK_FILE = join(process.env.REPO_ROOT || process.cwd(), ".opencode", "pipeline", ".monitor.lock");
const lock = acquireLock(LOCK_FILE);
if (!lock.acquired) {
    console.error(`\x1b[31mFoundry Monitor is already running (PID ${lock.existingPid}).\x1b[0m`);
    console.error(`If this is wrong, run: \x1b[33mrm ${LOCK_FILE}\x1b[0m`);
    process.exit(1);
}
// Clean up lock on exit
const cleanup = () => releaseLock(LOCK_FILE);
process.on("exit", cleanup);
process.on("SIGTERM", () => { cleanup(); process.exit(0); });
process.on("SIGINT", () => { cleanup(); process.exit(0); });
const tasksRoot = process.argv[2] || "";
render(_jsx(App, { tasksRoot: tasksRoot }));
