import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { env, exit } from "node:process";

const REPO_ROOT = env.PIPELINE_REPO_ROOT || resolve(__dirname, "../../../..");
const TASKS_ROOT = join(REPO_ROOT, "tasks");
const DEFAULT_HANDOFF = join(REPO_ROOT, ".opencode/pipeline/handoff.md");

interface Args {
  workflow: "builder" | "foundry" | "ultraworks";
  summaryFile?: string;
  sessionId?: string;
  handoffFile?: string;
  taskSlug?: string;
  sinceEpoch?: number;
}

interface Session {
  id: string;
  directory?: string;
  title?: string;
  created?: number;
  updated?: number;
}

interface HandoffSection {
  lines: string[];
  status: string;
}

function run(cmd: string[]): string {
  try {
    return execSync(cmd.join(" "), { cwd: REPO_ROOT, encoding: "utf-8" });
  } catch {
    return "";
  }
}

function latestSummary(sinceEpoch: number | null, workflow: string): string | null {
  const suffix = workflow === "ultraworks" ? "--ultraworks" : "--foundry";
  const files: string[] = [];
  
  try {
    const entries = readdirSync(TASKS_ROOT, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.endsWith(suffix)) continue;
      const summaryPath = join(TASKS_ROOT, entry.name, "summary.md");
      if (existsSync(summaryPath)) {
        files.push(summaryPath);
      }
    }
  } catch {
    return null;
  }
  
  if (files.length === 0) return null;
  
  let filtered = files;
  if (sinceEpoch !== null) {
    filtered = files.filter((f: string) => statSync(f).mtimeMs / 1000 >= sinceEpoch);
  }
  
  if (filtered.length === 0) return null;
  
  const sorted = filtered.sort((a: string, b: string) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return sorted[0];
}

function pickSession(sessionId: string | null, sinceEpoch: number | null): Session | null {
  try {
    const raw = run(["opencode", "session", "list", "--format", "json", "-n", "50"]);
    const sessions: Session[] = JSON.parse(raw);
    
    if (sessionId) {
      const found = sessions.find(s => s.id === sessionId);
      return found || null;
    }
    
    let candidates = sessions.filter(s => s.directory?.startsWith(REPO_ROOT));
    if (sinceEpoch !== null) {
      const sinceMs = sinceEpoch * 1000;
      candidates = candidates.filter(s => 
        (s.created || 0) >= sinceMs || (s.updated || 0) >= sinceMs
      );
    }
    candidates = candidates.filter(s => s.title !== "Greeting");
    
    if (candidates.length === 0) return null;
    
    return candidates.reduce((a, b) => (a.updated || 0) > (b.updated || 0) ? a : b);
  } catch {
    return null;
  }
}

function humanDuration(seconds: number): string {
  if (seconds >= 60) {
    return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
  }
  return `${seconds}s`;
}

function cleanMd(text: string): string {
  return text
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .trim()
    .replace(/^[-\s]+|[-\s]+$/g, "");
}

function extractSection(text: string, header: string): string {
  const pattern = new RegExp(`^## ${escapeRegex(header)}\\s*$([\\s\\S]*?)(?=^## |\\Z)`, "m");
  const match = text.match(pattern);
  return match ? match[1].trim() : "";
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractTitle(text: string): string {
  const match = text.match(/^#\s+(.+)$/m);
  return match ? cleanMd(match[1]) : "Pipeline Summary";
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function extractStatus(text: string): string {
  const lowered = text.toLowerCase();
  if (
    lowered.includes("pipeline incomplete") ||
    lowered.includes("**статус:** fail") ||
    lowered.includes("**status:** fail")
  ) {
    return "FAIL";
  }
  return "PASS";
}

function extractBulletsFromSummary(text: string): string[] {
  const bullets: string[] = [];
  const summarySection = extractSection(text, "Summary") || extractSection(text, "Що зроблено");
  
  for (const line of summarySection.split("\n")) {
    if (line.trim().startsWith("- ")) {
      bullets.push(cleanMd(line));
    }
  }
  
  const filesSection = extractSection(text, "Files Changed");
  for (const line of filesSection.split("\n")) {
    if (line.trim().startsWith("|") && !line.includes("File") && !line.includes("---")) {
      const parts = line
        .trim()
        .replace(/^\||\|$/g, "")
        .split("|")
        .map(p => p.trim());
      if (parts.length >= 3) {
        bullets.push(`${capitalize(parts[1])} ${parts[0]} — ${parts[2]}`);
      }
    }
  }
  
  const seen = new Set<string>();
  return bullets.filter(b => {
    if (!b || seen.has(b)) return false;
    seen.add(b);
    return true;
  });
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function parseHandoffSections(text: string): Record<string, HandoffSection> {
  const sections: Record<string, HandoffSection> = {};
  let current: string | null = null;
  
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trimEnd();
    const match = line.match(/^##\s+(.+)$/);
    if (match) {
      current = match[1].trim();
      sections[current] = { lines: [], status: "" };
      continue;
    }
    if (current) {
      sections[current].lines.push(line);
    }
  }
  
  for (const [name, section] of Object.entries(sections)) {
    let status = "";
    for (const line of section.lines) {
      const m = line.match(/- \*\*Status\*\*: (.+)/);
      if (m) {
        status = m[1].trim();
        break;
      }
    }
    sections[name].status = status;
  }
  
  return sections;
}

function bulletsFromHandoff(sections: Record<string, HandoffSection>): string[] {
  const items: string[] = [];
  const tokens = ["**Result**:", "**Completed**:", "**Files changed**:", "**Files Changed**:", "**Verification**:"];
  
  for (const [name, section] of Object.entries(sections)) {
    if (name.toLowerCase() === "task description" || name.toLowerCase() === "summarizer") continue;
    const status = section.status.toLowerCase();
    if (status !== "done" && status !== "completed") continue;
    
    for (const line of section.lines) {
      if (tokens.some(t => line.includes(t))) {
        items.push(`${name}: ${cleanMd(line)}`);
      }
    }
  }
  
  return items;
}

function difficultiesFromTexts(texts: string[]): string[] {
  const tokens = ["not installed", "error", "fail", "warning", "warn", "skipped", "flaky"];
  const items: string[] = [];
  
  for (const text of texts) {
    for (const line of text.split("\n")) {
      const lowered = line.toLowerCase();
      if (tokens.some(t => lowered.includes(t))) {
        items.push(cleanMd(line));
      }
    }
  }
  
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const item of items) {
    if (item && !seen.has(item)) {
      seen.add(item);
      deduped.push(item);
    }
  }
  
  return deduped.slice(0, 4);
}

function unfinishedFromHandoff(sections: Record<string, HandoffSection>): string[] {
  const items: string[] = [];
  
  for (const [name, section] of Object.entries(sections)) {
    const status = section.status.toLowerCase();
    if (status === "pending" || status === "in_progress" || status === "in progress") {
      items.push(`${name}: статус ${section.status}`);
    }
  }
  
  return items;
}

function nextTaskFromExisting(text: string): string {
  const nextSection = extractSection(text, "Next Steps") || extractSection(text, "Наступна задача");
  
  for (const line of nextSection.split("\n")) {
    const stripped = line.trim();
    if (stripped.startsWith("1.") || stripped.startsWith("2.") || stripped.startsWith("- ")) {
      return cleanMd(stripped.replace(/^[0-9]+\.\s*/, ""));
    }
  }
  
  return "Архівувати завершений change або запустити наступну незавершену OpenSpec задачу.";
}

function profileFromHandoff(text: string): string {
  const match = text.match(/- \*\*Profile\*\*: (.+)/);
  return match ? cleanMd(match[1]) : "—";
}

function taskNameFromHandoff(text: string): string {
  const match = text.match(/- \*\*Task\*\*: (.+)/);
  return match ? cleanMd(match[1]) : "";
}

function telemetryBlock(workflow: string, taskSlug: string, sessionId: string | null): string {
  const renderScript = join(REPO_ROOT, "agentic-development/monitor/src/cli/render-summary.ts");
  const trackerWorkflow = workflow === "builder" || workflow === "foundry" ? "foundry" : "ultraworks";
  
  let cmd: string[];
  if (trackerWorkflow === "foundry") {
    cmd = ["npx", "tsx", renderScript, "foundry", taskSlug];
  } else {
    cmd = ["npx", "tsx", renderScript, "ultraworks", ...(sessionId ? [sessionId] : [])];
  }
  
  const text = run(cmd).trim();
  let lines = text.split("\n");
  
  if (lines.length > 0 && lines[0].startsWith("**Workflow:**")) {
    lines = lines.slice(1);
    if (lines.length > 0 && lines[0].trim() === "") {
      lines = lines.slice(1);
    }
  }
  
  return lines.join("\n").trim();
}

function render(args: Args, summaryPath: string): string {
  const original = readFileSync(summaryPath, "utf-8");
  let handoffText = "";
  const handoffPath = args.handoffFile || DEFAULT_HANDOFF;
  
  if (existsSync(handoffPath)) {
    handoffText = readFileSync(handoffPath, "utf-8");
  }
  
  let title = extractTitle(original);
  
  if (handoffText) {
    const handoffTaskName = taskNameFromHandoff(handoffText);
    if (handoffTaskName && ["unknown", "pipeline summary", "pipeline summary: unknown"].includes(title.toLowerCase())) {
      title = handoffTaskName;
    }
  }
  
  if (handoffText) {
    const taskMatch = handoffText.match(/- \*\*Task\*\*: (.+)/);
    if (taskMatch) {
      const handoffTask = cleanMd(taskMatch[1]);
      const titleSlug = slugify(title);
      const handoffSlug = slugify(handoffTask);
      if (titleSlug && handoffSlug && !titleSlug.includes(handoffSlug) && !handoffSlug.includes(titleSlug)) {
        handoffText = "";
      }
    }
  }
  
  const status = extractStatus(original);
  const session = pickSession(args.sessionId || null, args.sinceEpoch || null);
  const sessionId = session?.id || null;
  let duration = "—";
  
  if (session) {
    const seconds = Math.max(0, Math.floor(((session.updated || 0) - (session.created || 0)) / 1000));
    duration = humanDuration(seconds);
  }
  
  const profile = profileFromHandoff(handoffText);
  const sections = handoffText ? parseHandoffSections(handoffText) : {};
  
  let doneItems = extractBulletsFromSummary(original);
  if (doneItems.length === 0) {
    doneItems = bulletsFromHandoff(sections);
  }
  if (doneItems.length === 0) {
    doneItems = ["Результати зафіксовані в summary, але деталізовані bullet points не були знайдені."];
  }
  
  let difficulties = difficultiesFromTexts([original, handoffText]);
  if (difficulties.length === 0) {
    difficulties = ["Суттєвих блокерів під час цього запуску не зафіксовано."];
  }
  
  let unfinished = unfinishedFromHandoff(sections);
  if (unfinished.length === 0 && status === "PASS") {
    unfinished = ["Немає незавершених пунктів у межах цього запуску."];
  } else if (unfinished.length === 0) {
    unfinished = ["Є незавершені роботи; див. handoff та telemetry для деталей."];
  }
  
  const nextTask = nextTaskFromExisting(original);
  const taskSlug = args.taskSlug || summaryPath.split("/").pop()?.replace(".md", "") || "unknown";
  const telemetry = telemetryBlock(args.workflow, taskSlug, sessionId);
  
  // Extract Files Changed By Agent section from original summary (pass-through from telemetry block)
  const filesChangedSection = extractSection(original, "Files Changed By Agent");

  const lines: string[] = [
    `# ${title}`,
    "",
    `**Статус:** ${status}`,
    `**Workflow:** ${args.workflow === "foundry" ? "Foundry" : "Ultraworks"}`,
    `**Профіль:** ${profile}`,
    `**Тривалість:** ${duration}`,
    "",
    "## Що зроблено",
  ];
  
  lines.push(...doneItems.map(i => `- ${i}`));
  lines.push("", "## Труднощі");
  lines.push(...difficulties.map(d => `- ${d}`));
  lines.push("", "## Незавершене");
  lines.push(...unfinished.map(u => `- ${u}`));
  lines.push("", "## Наступна задача", nextTask.trim());
  lines.push("", "---", "", telemetry);

  if (filesChangedSection) {
    lines.push("", "## Files Changed By Agent", "", filesChangedSection);
  }
  
  return lines.join("\n").trim() + "\n";
}

function parseArgs(): Args {
  const args: Partial<Args> = {};
  const argv = process.argv.slice(2);
  
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--workflow":
        args.workflow = argv[++i] as Args["workflow"];
        break;
      case "--summary-file":
        args.summaryFile = argv[++i];
        break;
      case "--session-id":
        args.sessionId = argv[++i];
        break;
      case "--handoff-file":
        args.handoffFile = argv[++i];
        break;
      case "--task-slug":
        args.taskSlug = argv[++i];
        break;
      case "--since-epoch":
        args.sinceEpoch = parseInt(argv[++i], 10);
        break;
    }
  }
  
  if (!args.workflow) {
    console.error("--workflow is required");
    exit(1);
  }
  
  return args as Args;
}

export function normalizeSummary(args: Args): string | null {
  const summaryPath = args.summaryFile || latestSummary(args.sinceEpoch || null, args.workflow);
  
  if (!summaryPath || !existsSync(summaryPath)) {
    console.error("No summary file found to normalize.");
    return null;
  }
  
  const normalized = render(args, summaryPath);
  writeFileSync(summaryPath, normalized, "utf-8");
  console.log(summaryPath);
  return summaryPath;
}

// CLI entry point - only run when executed directly
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("normalize-summary.ts")) {
  const args = parseArgs();
  const result = normalizeSummary(args);
  if (!result) exit(1);
}
