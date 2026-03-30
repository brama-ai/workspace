/**
 * `foundry init-env` — auto-generate env-check.json by scanning the project.
 *
 * Detects:
 *  - Docker Compose files in docker/ and project root
 *  - Services with healthchecks → required_services
 *  - Services without healthchecks → optional_services
 *  - Management UIs (ports like 15672, 8080, 5601) → healthcheck_urls
 *  - Runtime tools (php, node, python3, composer, npm) → commands
 *  - Builds the up_command from discovered compose files
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, relative } from "node:path";

// ── Types matching env-check.json schema ─────────────────────────

interface RequiredService {
  name: string;
  healthcheck: boolean;
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

interface EnvCheckJson {
  $comment: string;
  compose_files: string[];
  required_services: RequiredService[];
  optional_services: string[];
  healthcheck_urls: HealthcheckUrl[];
  commands: CommandCheck[];
  up_command: string;
}

// ── Well-known management UI ports ───────────────────────────────

const KNOWN_UIS: Record<number, string> = {
  15672: "RabbitMQ management",
  8080:  "Traefik dashboard",
  5601:  "OpenSearch Dashboards",
  9200:  "OpenSearch API",
  4000:  "LiteLLM proxy",
  3000:  "Langfuse web",
  5050:  "pgAdmin",
  8025:  "MailHog",
  6380:  "RedisInsight",
};

// ── Well-known infrastructure services (typically required) ──────

const INFRA_SERVICES = new Set([
  "postgres", "postgresql", "mysql", "mariadb", "mongo", "mongodb",
  "redis", "memcached", "rabbitmq", "nats",
  "opensearch", "elasticsearch", "meilisearch",
]);

// ── Well-known app services (typically optional) ─────────────────

const OPTIONAL_PATTERNS = [
  /dashboard/i, /admin/i, /ui$/i, /web$/i, /monitor/i, /grafana/i,
  /prometheus/i, /jaeger/i, /zipkin/i, /mailhog/i, /mailtrap/i,
];

// ── Runtime detection ────────────────────────────────────────────

interface RuntimeProbe {
  cmd: string;
  label: string;
  detect: string[];   // files/dirs that indicate this runtime is needed
}

const RUNTIME_PROBES: RuntimeProbe[] = [
  { cmd: "docker info",       label: "Docker daemon",  detect: [] }, // always included
  { cmd: "git --version",     label: "Git",            detect: [".git"] },
  { cmd: "php -v",            label: "PHP",            detect: ["composer.json", "symfony.lock", "artisan"] },
  { cmd: "composer --version",label: "Composer",        detect: ["composer.json"] },
  { cmd: "node --version",    label: "Node.js",        detect: ["package.json", "tsconfig.json"] },
  { cmd: "npm --version",     label: "npm",            detect: ["package.json", "package-lock.json"] },
  { cmd: "python3 --version", label: "Python 3",       detect: ["requirements.txt", "pyproject.toml", "setup.py", "Pipfile"] },
  { cmd: "pip --version",     label: "pip",            detect: ["requirements.txt"] },
];

// ── Compose file discovery ───────────────────────────────────────

function discoverComposeFiles(repoRoot: string): string[] {
  const found: string[] = [];

  // Check docker/ directory
  const dockerDir = join(repoRoot, "docker");
  if (existsSync(dockerDir)) {
    try {
      const files = readdirSync(dockerDir).filter(
        (f) => f.startsWith("compose") && f.endsWith(".yaml") && !f.includes("override") && !f.includes("e2e"),
      );
      // Sort: base compose.yaml first, then compose.core.yaml, then alphabetically
      files.sort((a, b) => {
        if (a === "compose.yaml") return -1;
        if (b === "compose.yaml") return 1;
        if (a === "compose.core.yaml") return -1;
        if (b === "compose.core.yaml") return 1;
        return a.localeCompare(b);
      });
      for (const f of files) {
        found.push(`docker/${f}`);
      }
    } catch { /* ignore */ }
  }

  // Check project root
  const rootFiles = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];
  for (const f of rootFiles) {
    if (existsSync(join(repoRoot, f)) && !found.includes(f)) {
      found.push(f);
    }
  }

  return found;
}

// ── Parse compose config ─────────────────────────────────────────

interface ComposeService {
  name: string;
  hasHealthcheck: boolean;
  ports: Array<{ published: number; target: number }>;
}

/**
 * Try to parse compose config with a set of files.
 * Returns services or empty array if parsing fails.
 */
function tryParseCompose(repoRoot: string, files: string[]): ComposeService[] {
  if (files.length === 0) return [];

  const args = files
    .map((f) => {
      const abs = f.startsWith("/") ? f : join(repoRoot, f);
      return existsSync(abs) ? `-f ${abs}` : null;
    })
    .filter(Boolean)
    .join(" ");

  if (!args) return [];

  try {
    const raw = execSync(`docker compose ${args} config --format json`, {
      encoding: "utf-8",
      timeout: 15_000,
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const data = JSON.parse(raw);
    const services: ComposeService[] = [];

    for (const [name, svc] of Object.entries(data.services || {})) {
      const s = svc as any;
      const hasHealthcheck = !!s.healthcheck;
      const ports: ComposeService["ports"] = [];

      if (Array.isArray(s.ports)) {
        for (const p of s.ports) {
          if (typeof p === "object" && p.published && p.target) {
            ports.push({ published: Number(p.published), target: Number(p.target) });
          } else if (typeof p === "string") {
            const m = p.match(/^(\d+):(\d+)/);
            if (m) ports.push({ published: Number(m[1]), target: Number(m[2]) });
          }
        }
      }

      services.push({ name, hasHealthcheck, ports });
    }

    return services;
  } catch {
    return [];
  }
}

/**
 * Parse compose config with incremental strategy:
 *  1. Try all discovered files together
 *  2. If that fails, try just base files (compose.yaml + compose.core.yaml)
 *  3. If that fails, try each file individually and merge results
 *
 * Also returns the list of files that actually parsed successfully
 * (used for compose_files in the output config).
 */
function parseComposeConfig(
  repoRoot: string,
  composeFiles: string[],
): { services: ComposeService[]; parsedFiles: string[] } {
  if (composeFiles.length === 0) return { services: [], parsedFiles: [] };

  // Strategy 1: try all files at once
  const allServices = tryParseCompose(repoRoot, composeFiles);
  if (allServices.length > 0) {
    return { services: allServices, parsedFiles: composeFiles };
  }

  // Strategy 2: try just the base files (compose.yaml + compose.core.yaml)
  const baseFiles = composeFiles.filter(
    (f) => f.endsWith("/compose.yaml") || f.endsWith("/compose.core.yaml") ||
           f === "compose.yaml" || f === "compose.yml" ||
           f === "docker-compose.yaml" || f === "docker-compose.yml",
  );
  if (baseFiles.length > 0) {
    const baseServices = tryParseCompose(repoRoot, baseFiles);
    if (baseServices.length > 0) {
      return { services: baseServices, parsedFiles: baseFiles };
    }
  }

  // Strategy 3: try each file individually, merge
  const merged: ComposeService[] = [];
  const parsedFiles: string[] = [];
  const seen = new Set<string>();

  for (const file of composeFiles) {
    const svcs = tryParseCompose(repoRoot, [file]);
    for (const svc of svcs) {
      if (!seen.has(svc.name)) {
        seen.add(svc.name);
        merged.push(svc);
      }
    }
    if (svcs.length > 0) parsedFiles.push(file);
  }

  return { services: merged, parsedFiles };
}

// ── Classify services ────────────────────────────────────────────

function classifyServices(services: ComposeService[]): {
  required: RequiredService[];
  optional: string[];
  urls: HealthcheckUrl[];
} {
  const required: RequiredService[] = [];
  const optional: string[] = [];
  const urls: HealthcheckUrl[] = [];

  for (const svc of services) {
    const isInfra = INFRA_SERVICES.has(svc.name);
    const isOptionalPattern = OPTIONAL_PATTERNS.some((p) => p.test(svc.name));

    if (isInfra || svc.hasHealthcheck) {
      // Services with healthchecks or infra services → required
      required.push({ name: svc.name, healthcheck: svc.hasHealthcheck });
    } else if (isOptionalPattern) {
      optional.push(svc.name);
    } else {
      // Everything else → optional
      optional.push(svc.name);
    }

    // Detect management UI ports
    for (const port of svc.ports) {
      const label = KNOWN_UIS[port.published];
      if (label) {
        urls.push({
          url: `http://localhost:${port.published}`,
          label,
          required: false,
        });
      }
    }
  }

  return { required, optional, urls };
}

// ── Detect runtime commands ──────────────────────────────────────

function detectCommands(repoRoot: string): CommandCheck[] {
  const commands: CommandCheck[] = [];

  for (const probe of RUNTIME_PROBES) {
    // "docker info" and ".git" are always relevant
    if (probe.detect.length === 0) {
      commands.push({ cmd: probe.cmd, label: probe.label, required: true });
      continue;
    }

    const needed = probe.detect.some((f) => existsSync(join(repoRoot, f)));
    if (needed) {
      commands.push({ cmd: probe.cmd, label: probe.label, required: true });
    }
  }

  return commands;
}

// ── Build up_command ─────────────────────────────────────────────

function buildUpCommand(composeFiles: string[]): string {
  if (composeFiles.length === 0) return "";
  const args = composeFiles.map((f) => `-f ${f}`).join(" ");
  return `docker compose ${args} up -d`;
}

// ── Main generator ───────────────────────────────────────────────

export interface InitEnvResult {
  config: EnvCheckJson;
  written: boolean;
  path: string;
  skipped: boolean;    // true if file already exists and --force not set
  message: string;
}

export function generateEnvCheck(repoRoot: string, force: boolean = false): InitEnvResult {
  const outPath = join(repoRoot, "env-check.json");

  // Guard: don't overwrite without --force
  if (existsSync(outPath) && !force) {
    const existing = JSON.parse(readFileSync(outPath, "utf-8"));
    return {
      config: existing,
      written: false,
      path: outPath,
      skipped: true,
      message: `env-check.json already exists. Use --force to overwrite.`,
    };
  }

  // 1. Discover compose files
  const discoveredFiles = discoverComposeFiles(repoRoot);

  // 2. Parse compose config (needs docker to be running)
  const { services, parsedFiles } = parseComposeConfig(repoRoot, discoveredFiles);

  // Use parsed files for config (only files that actually work)
  const composeFiles = parsedFiles.length > 0 ? parsedFiles : discoveredFiles;

  // 3. Classify services
  const { required, optional, urls } = classifyServices(services);

  // 4. Detect runtime commands
  const commands = detectCommands(repoRoot);

  // 5. Build up_command
  const upCommand = buildUpCommand(composeFiles);

  // 6. Assemble config
  const config: EnvCheckJson = {
    $comment: "Auto-generated by `foundry init-env`. See: docs/pipeline/en/env-check.md",
    compose_files: composeFiles,
    required_services: required,
    optional_services: optional,
    healthcheck_urls: urls,
    commands,
    up_command: upCommand,
  };

  // 7. Write
  writeFileSync(outPath, JSON.stringify(config, null, 2) + "\n", "utf-8");

  // 8. Summary
  const summary = [
    `Generated env-check.json`,
    `  Compose files:      ${composeFiles.length}`,
    `  Required services:  ${required.length} (${required.map((s) => s.name).join(", ") || "none"})`,
    `  Optional services:  ${optional.length}`,
    `  Healthcheck URLs:   ${urls.length}`,
    `  Commands:           ${commands.length}`,
    `  Up command:         ${upCommand || "(none)"}`,
    ``,
    `  Written to: ${outPath}`,
    `  Review and adjust as needed.`,
  ].join("\n");

  return {
    config,
    written: true,
    path: outPath,
    skipped: false,
    message: summary,
  };
}

// ── CLI entry point ──────────────────────────────────────────────

export function cmdInitEnv(args: string[], repoRoot: string): number {
  const force = args.includes("--force") || args.includes("-f");
  const result = generateEnvCheck(repoRoot, force);

  console.log(result.message);

  if (result.skipped) {
    return 1;
  }

  return 0;
}
