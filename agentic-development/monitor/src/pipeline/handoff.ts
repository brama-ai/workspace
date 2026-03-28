import { existsSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, unlinkSync, lstatSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname, basename } from "node:path";
import { env } from "node:process";

const DEBUG = env.FOUNDRY_DEBUG === "true";

function debug(...args: unknown[]): void {
  if (!DEBUG) return;
  console.error(`[${new Date().toISOString().slice(11, 23)}] [handoff]`, ...args);
}

export interface HandoffSection {
  agent: string;
  content: string;
  timestamp: string;
}

const PIPELINE_DIR = env.PIPELINE_DIR || join(env.REPO_ROOT || process.cwd(), ".opencode/pipeline");

export function readHandoff(handoffFile: string): string {
  if (!existsSync(handoffFile)) {
    return "";
  }
  return readFileSync(handoffFile, "utf8");
}

export function writeHandoff(handoffFile: string, content: string): void {
  const dir = dirname(handoffFile);
  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(handoffFile, content, "utf8");
    debug("Wrote handoff:", handoffFile, `(${content.length} bytes)`);
  } catch (err) {
    console.error(`[handoff] ERROR: failed to write ${handoffFile}: ${err}`);
    throw err; // Re-throw so caller can log via rlog
  }
}

export function appendHandoff(handoffFile: string, section: string, content: string): void {
  const existing = readHandoff(handoffFile);
  const timestamp = new Date().toISOString().slice(0, 19).replace("T", " ");
  
  const newSection = `
---

## ${section}

${content}

*Updated: ${timestamp}*
`;

  writeHandoff(handoffFile, existing + newSection);
}

export function updateSection(handoffFile: string, sectionName: string, content: string): void {
  const existing = readHandoff(handoffFile);
  const timestamp = new Date().toISOString().slice(0, 19).replace("T", " ");
  
  const sectionHeader = `## ${sectionName}`;
  const sectionPattern = new RegExp(
    `(## ${sectionName}[\\s\\S]*?)(?=## |$)`,
    "g"
  );

  const newSection = `## ${sectionName}

${content}

*Updated: ${timestamp}*
`;

  if (sectionPattern.test(existing)) {
    const updated = existing.replace(sectionPattern, newSection);
    writeHandoff(handoffFile, updated);
  } else {
    appendHandoff(handoffFile, sectionName, content);
  }
}

export function readSection(handoffFile: string, sectionName: string): string | null {
  const content = readHandoff(handoffFile);
  if (!content) return null;

  const sectionPattern = new RegExp(
    `## ${sectionName}[\\s\\S]*?(?=## |$)`,
    "g"
  );

  const match = sectionPattern.exec(content);
  if (!match) return null;

  return match[0]
    .replace(`## ${sectionName}`, "")
    .replace(/\*Updated:.*\*/, "")
    .trim();
}

export function extractFiles(handoffFile: string): string[] {
  const content = readHandoff(handoffFile);
  if (!content) return [];

  const filePattern = /(?:file|path|changed|modified|created):\s*`?([^\s`\n]+)`?/gi;
  const files: string[] = [];
  let match;

  while ((match = filePattern.exec(content)) !== null) {
    files.push(match[1]);
  }

  return [...new Set(files)];
}

export function extractBranch(handoffFile: string): string | null {
  const content = readHandoff(handoffFile);
  if (!content) return null;

  const branchPattern = /(?:branch|br):\s*`?([^\s`\n]+)`?/i;
  const match = branchPattern.exec(content);
  return match ? match[1] : null;
}

// 8.3: createHandoffLink() is kept for backward compatibility but no longer called
// by initHandoff(). Agents use <task_dir>/handoff.md directly.
export function createHandoffLink(taskDir: string, pipelineDir: string = PIPELINE_DIR): string {
  const handoffFile = join(taskDir, "handoff.md");
  const linkFile = join(pipelineDir, "handoff.md");

  try {
    const stat = lstatSync(linkFile);
    if (stat.isSymbolicLink() || stat.isFile()) {
      unlinkSync(linkFile);
    }
  } catch {
    // File doesn't exist, ignore
  }

  if (!existsSync(pipelineDir)) {
    mkdirSync(pipelineDir, { recursive: true });
  }

  symlinkSync(handoffFile, linkFile);
  debug("Created symlink:", linkFile, "->", handoffFile);

  return linkFile;
}

export function initHandoff(taskDir: string, taskMessage: string, branch: string): string {
  const handoffFile = join(taskDir, "handoff.md");
  const timestamp = new Date().toISOString().slice(0, 19).replace("T", " ");

  const template = `# Pipeline Handoff

**Task:** ${taskMessage}
**Branch:** ${branch}
**Started:** ${timestamp}

---

`;

  writeHandoff(handoffFile, template);
  // 8.3: No longer creating global symlink — handoff is task-scoped
  // createHandoffLink(taskDir);  // removed

  return handoffFile;
}

export function summarizeHandoff(handoffFile: string): {
  sections: string[];
  files: string[];
  branch: string | null;
} {
  const content = readHandoff(handoffFile);
  
  const sectionPattern = /## (.+)/g;
  const sections: string[] = [];
  let match;
  
  while ((match = sectionPattern.exec(content)) !== null) {
    sections.push(match[1]);
  }

  return {
    sections,
    files: extractFiles(handoffFile),
    branch: extractBranch(handoffFile),
  };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const [cmd, ...args] = process.argv.slice(2);

  switch (cmd) {
    case "read": {
      const file = args[0];
      console.log(readHandoff(file));
      break;
    }
    case "section": {
      const [file, section] = args;
      const content = readSection(file, section);
      console.log(content || "(not found)");
      break;
    }
    case "files": {
      const file = args[0];
      extractFiles(file).forEach(f => console.log(f));
      break;
    }
    case "init": {
      const [taskDir, taskMessage, branch] = args;
      const file = initHandoff(taskDir, taskMessage, branch);
      console.log(file);
      break;
    }
    default:
      console.error(`Unknown command: ${cmd}`);
      console.error("Commands: read, section, files, init");
      process.exit(1);
  }
}
