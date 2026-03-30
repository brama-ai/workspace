/**
 * Environment status checker — configurable per project via env-check.json.
 *
 * Every project MUST have an `env-check.json` in its root.
 * When the file is missing, all checks fail with a clear error
 * pointing to the documentation.
 *
 * Docs: docs/pipeline/{ua,en}/env-check.md
 *
 * Used by:
 *  1. TUI header (green/red ENV indicator with failure reasons)
 *  2. Pipeline runner pre-task gate (fail early if env not ready)
 *  3. "Up environment" TUI command ([e] key)
 */

import { execSync, exec } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ── env-check.json schema types ──────────────────────────────────

interface RequiredService {
  name: string;
  healthcheck?: boolean;   // true = must be healthy, not just running
}

interface HealthcheckUrl {
  url: string;
  label: string;
  required: boolean;
}

interface CommandCheck {
  cmd: string;
  label: string;
  required: boolean;
}

export interface EnvCheckConfig {
  compose_files: string[];
  required_services: RequiredService[];
  optional_services?: string[];
  healthcheck_urls?: HealthcheckUrl[];
  commands?: CommandCheck[];
  up_command?: string;
}

// ── Runtime types ────────────────────────────────────────────────

export interface ServiceStatus {
  name: string;
  running: boolean;
  healthy: boolean | null;  // null = no healthcheck defined
  status: string;           // raw docker status string
}

export interface EnvStatus {
  ready: boolean;
  configMissing: boolean;   // true when env-check.json not found
  dockerRunning: boolean;
  services: ServiceStatus[];
  errors: string[];         // human-readable failure reasons
  checkedAt: number;        // Date.now() timestamp
}

// ── Constants ────────────────────────────────────────────────────

const CONFIG_FILENAME = "env-check.json";
const DOCS_PATH = "docs/pipeline/en/env-check.md";
const MISSING_CONFIG_ERROR = `${CONFIG_FILENAME} not found. Create it in the project root. See: ${DOCS_PATH}`;

// ── Config loader ────────────────────────────────────────────────

let _configCache: { path: string; config: EnvCheckConfig | null } | null = null;

/**
 * Load env-check.json from the project root.
 * Returns null when the file is missing — callers must handle this.
 */
export function loadEnvCheckConfig(repoRoot: string): EnvCheckConfig | null {
  const configPath = join(repoRoot, CONFIG_FILENAME);

  // Return cached if same path
  if (_configCache && _configCache.path === configPath) {
    return _configCache.config;
  }

  if (!existsSync(configPath)) {
    _configCache = { path: configPath, config: null };
    return null;
  }

  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw);

    // Normalize required_services: accept both string[] and RequiredService[]
    const requiredServices: RequiredService[] = (parsed.required_services || []).map(
      (s: string | RequiredService) =>
        typeof s === "string" ? { name: s, healthcheck: false } : s,
    );

    const config: EnvCheckConfig = {
      compose_files:      parsed.compose_files || [],
      required_services:  requiredServices,
      optional_services:  parsed.optional_services || [],
      healthcheck_urls:   parsed.healthcheck_urls || [],
      commands:           parsed.commands || [],
      up_command:         parsed.up_command || undefined,
    };

    _configCache = { path: configPath, config };
    return config;
  } catch {
    // Malformed JSON — treat as missing
    _configCache = { path: configPath, config: null };
    return null;
  }
}

/** Force reload config (e.g. after creating/editing env-check.json) */
export function invalidateEnvCheckConfigCache(): void {
  _configCache = null;
}

// ── Compose CLI builder ──────────────────────────────────────────

function composeCli(repoRoot: string, config: EnvCheckConfig): string {
  const files = config.compose_files
    .map((f) => {
      const abs = f.startsWith("/") ? f : join(repoRoot, f);
      return existsSync(abs) ? `-f ${abs}` : null;
    })
    .filter(Boolean)
    .join(" ");

  return files ? `docker compose ${files}` : "docker compose";
}

// ── Docker availability ──────────────────────────────────────────

function isDockerRunning(): boolean {
  try {
    execSync("docker info", { stdio: "pipe", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

// ── Command checks ───────────────────────────────────────────────

function runCommandChecks(commands: CommandCheck[]): string[] {
  const errors: string[] = [];
  for (const c of commands) {
    // Skip "docker info" — already checked separately
    if (c.cmd === "docker info") continue;
    try {
      execSync(c.cmd, { stdio: "pipe", timeout: 5000 });
    } catch {
      if (c.required) {
        errors.push(`${c.label}: command failed (${c.cmd})`);
      }
    }
  }
  return errors;
}

// ── HTTP healthcheck URLs ────────────────────────────────────────

function checkHealthUrls(urls: HealthcheckUrl[]): string[] {
  const errors: string[] = [];
  for (const u of urls) {
    try {
      execSync(`curl -sf --max-time 3 "${u.url}" > /dev/null 2>&1`, {
        stdio: "pipe",
        timeout: 5000,
        shell: "/bin/sh",
      });
    } catch {
      if (u.required) {
        errors.push(`${u.label}: ${u.url} not responding`);
      }
    }
  }
  return errors;
}

// ── Parse `docker compose ps --format json` ──────────────────────

function parseComposeServices(
  repoRoot: string,
  config: EnvCheckConfig,
): ServiceStatus[] {
  const services: ServiceStatus[] = [];
  try {
    const cli = composeCli(repoRoot, config);
    const raw = execSync(`${cli} ps --format json --all`, {
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
      cwd: repoRoot,
    }).trim();

    if (!raw) return services;

    // NDJSON — one JSON object per line
    const lines = raw.split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        const name: string = obj.Service || obj.Name || "";
        const state: string = (obj.State || "").toLowerCase();
        const health: string = (obj.Health || "").toLowerCase();

        const running = state === "running";
        let healthy: boolean | null = null;
        if (health === "healthy") healthy = true;
        else if (health === "unhealthy" || health === "starting") healthy = false;

        const statusStr = health ? `${state} (${health})` : state;
        services.push({ name, running, healthy, status: statusStr });
      } catch {
        // skip malformed lines
      }
    }
  } catch {
    // compose not available or project not running
  }

  return services;
}

// ── Validate services against config ─────────────────────────────

function validateServices(
  services: ServiceStatus[],
  config: EnvCheckConfig,
): string[] {
  const errors: string[] = [];

  for (const req of config.required_services) {
    const svc = services.find((s) => s.name === req.name);
    if (!svc) {
      errors.push(`${req.name}: not found (not started)`);
    } else if (!svc.running) {
      errors.push(`${req.name}: ${svc.status || "not running"}`);
    } else if (req.healthcheck && svc.healthy === false) {
      errors.push(`${req.name}: unhealthy`);
    }
  }

  return errors;
}

// ── Missing-config result helper ─────────────────────────────────

function missingConfigResult(): EnvStatus {
  return {
    ready: false,
    configMissing: true,
    dockerRunning: false,
    services: [],
    errors: [MISSING_CONFIG_ERROR],
    checkedAt: Date.now(),
  };
}

// ── Main checker (sync) ──────────────────────────────────────────

export function checkEnvStatus(repoRoot: string): EnvStatus {
  const config = loadEnvCheckConfig(repoRoot);
  if (!config) return missingConfigResult();

  const errors: string[] = [];

  // 1. Docker daemon
  const dockerRunning = isDockerRunning();
  if (!dockerRunning) {
    return {
      ready: false,
      configMissing: false,
      dockerRunning: false,
      services: [],
      errors: ["Docker daemon is not running"],
      checkedAt: Date.now(),
    };
  }

  // 2. Extra command checks
  if (config.commands && config.commands.length > 0) {
    errors.push(...runCommandChecks(config.commands));
  }

  // 3. Compose services
  const services = parseComposeServices(repoRoot, config);
  if (services.length === 0 && config.required_services.length > 0) {
    errors.push("No compose services found (stack not started?)");
  }

  // 4. Validate required services
  errors.push(...validateServices(services, config));

  // 5. Healthcheck URLs
  if (config.healthcheck_urls && config.healthcheck_urls.length > 0) {
    errors.push(...checkHealthUrls(config.healthcheck_urls));
  }

  const ready = errors.length === 0 && (services.length > 0 || config.required_services.length === 0);
  return { ready, configMissing: false, dockerRunning, services, errors, checkedAt: Date.now() };
}

// ── Async version (non-blocking for TUI) ─────────────────────────

export function checkEnvStatusAsync(
  repoRoot: string,
  cb: (status: EnvStatus) => void,
): void {
  const config = loadEnvCheckConfig(repoRoot);
  if (!config) {
    cb(missingConfigResult());
    return;
  }

  // Quick docker check first (sync — fast)
  if (!isDockerRunning()) {
    cb({
      ready: false,
      configMissing: false,
      dockerRunning: false,
      services: [],
      errors: ["Docker daemon is not running"],
      checkedAt: Date.now(),
    });
    return;
  }

  const cli = composeCli(repoRoot, config);
  exec(`${cli} ps --format json --all`, {
    encoding: "utf-8",
    timeout: 10_000,
    cwd: repoRoot,
  }, (err, stdout) => {
    const services: ServiceStatus[] = [];
    const errors: string[] = [];

    // Command checks (sync, fast)
    if (config.commands && config.commands.length > 0) {
      errors.push(...runCommandChecks(config.commands));
    }

    if (err || !stdout?.trim()) {
      if (config.required_services.length > 0) {
        errors.push("No compose services found (stack not started?)");
      }
    } else {
      const lines = stdout.trim().split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          const name: string = obj.Service || obj.Name || "";
          const state: string = (obj.State || "").toLowerCase();
          const health: string = (obj.Health || "").toLowerCase();

          const running = state === "running";
          let healthy: boolean | null = null;
          if (health === "healthy") healthy = true;
          else if (health === "unhealthy" || health === "starting") healthy = false;

          const statusStr = health ? `${state} (${health})` : state;
          services.push({ name, running, healthy, status: statusStr });
        } catch {
          // skip
        }
      }
    }

    // Validate required services
    errors.push(...validateServices(services, config));

    // Healthcheck URLs (sync inside async callback — acceptable, curl is fast)
    if (config.healthcheck_urls && config.healthcheck_urls.length > 0) {
      errors.push(...checkHealthUrls(config.healthcheck_urls));
    }

    const ready = errors.length === 0 && (services.length > 0 || config.required_services.length === 0);
    cb({ ready, configMissing: false, dockerRunning: true, services, errors, checkedAt: Date.now() });
  });
}

// ── Up environment command ───────────────────────────────────────

export interface UpEnvResult {
  success: boolean;
  message: string;
}

/**
 * Start docker compose services.
 * Uses up_command from env-check.json if available, otherwise builds from compose_files.
 * Returns error when env-check.json is missing.
 */
export function upEnvironment(repoRoot: string): UpEnvResult {
  const config = loadEnvCheckConfig(repoRoot);
  if (!config) {
    return { success: false, message: MISSING_CONFIG_ERROR };
  }

  // Build the up command
  const cmd = config.up_command || `${composeCli(repoRoot, config)} up -d`;

  try {
    // Kill old tmux session if exists
    try {
      execSync('tmux kill-session -t "env-up" 2>/dev/null', { stdio: "ignore" });
    } catch { /* ignore */ }

    execSync(
      `tmux new-session -d -s "env-up" -c "${repoRoot}" '${cmd}; echo ""; echo "Done. Press Enter to close."; read'`,
      { cwd: repoRoot, stdio: "ignore" },
    );

    return {
      success: true,
      message: "Environment starting... (tmux attach -t env-up)",
    };
  } catch {
    // Fallback: try direct detached up
    try {
      execSync(cmd, { cwd: repoRoot, timeout: 120_000, stdio: "pipe" });
      return { success: true, message: "Environment started" };
    } catch (e: any) {
      return { success: false, message: `Failed to start: ${e.message?.slice(0, 80)}` };
    }
  }
}
