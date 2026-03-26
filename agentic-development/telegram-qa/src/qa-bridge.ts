/**
 * Q&A Bridge: reads/writes qa.json and triggers foundry.sh resume-qa.
 * Provides the interface between the Telegram bot and the Foundry pipeline.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

export interface QAData {
  version: number;
  questions: Question[];
}

export interface Question {
  id: string;
  agent: string;
  timestamp: string;
  priority: "blocking" | "non-blocking";
  category: string;
  question: string;
  context?: string;
  options?: string[];
  answer: string | null;
  answered_at: string | null;
  answered_by: string | null;
  answer_source?: string | null;
}

export interface WaitingTask {
  slug: string;
  taskDir: string;
  waitingAgent: string;
  questions: Question[];
  waitingSince?: string;
}

/**
 * Find all tasks in waiting_answer state.
 */
export function findWaitingTasks(tasksRoot: string): WaitingTask[] {
  const waiting: WaitingTask[] = [];

  let entries: string[];
  try {
    entries = readdirSync(tasksRoot);
  } catch {
    return waiting;
  }

  for (const entry of entries) {
    if (!entry.includes("--foundry")) continue;
    const taskDir = join(tasksRoot, entry);

    // Check state.json
    const statePath = join(taskDir, "state.json");
    if (!existsSync(statePath)) continue;

    let state: any;
    try {
      state = JSON.parse(readFileSync(statePath, "utf-8"));
    } catch {
      continue;
    }

    if (state.status !== "waiting_answer") continue;

    // Read qa.json
    const qaPath = join(taskDir, "qa.json");
    if (!existsSync(qaPath)) continue;

    let qaData: QAData;
    try {
      qaData = JSON.parse(readFileSync(qaPath, "utf-8"));
    } catch {
      continue;
    }

    const slug = entry.replace(/--foundry.*/, "");
    waiting.push({
      slug,
      taskDir,
      waitingAgent: state.waiting_agent ?? "unknown",
      questions: qaData.questions ?? [],
      waitingSince: state.waiting_since,
    });
  }

  return waiting;
}

/**
 * Read qa.json for a specific task.
 */
export function readQA(taskDir: string): QAData | null {
  const qaPath = join(taskDir, "qa.json");
  if (!existsSync(qaPath)) return null;
  try {
    return JSON.parse(readFileSync(qaPath, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Write an answer to qa.json.
 */
export function writeAnswer(
  taskDir: string,
  questionId: string,
  answer: string,
  answeredBy: string = "human",
  answerSource: string = "telegram"
): boolean {
  const qaPath = join(taskDir, "qa.json");
  if (!existsSync(qaPath)) return false;

  let data: QAData;
  try {
    data = JSON.parse(readFileSync(qaPath, "utf-8"));
  } catch {
    return false;
  }

  let found = false;
  for (const q of data.questions) {
    if (q.id === questionId) {
      q.answer = answer;
      q.answered_at = new Date().toISOString();
      q.answered_by = answeredBy;
      q.answer_source = answerSource;
      found = true;
      break;
    }
  }

  if (!found) return false;

  try {
    writeFileSync(qaPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if all blocking questions are answered.
 */
export function allBlockingAnswered(questions: Question[]): boolean {
  return questions
    .filter((q) => q.priority === "blocking")
    .every((q) => q.answer !== null);
}

/**
 * Trigger foundry.sh resume-qa for a task.
 */
export function triggerResumeQA(
  foundryShPath: string,
  taskSlug: string
): { success: boolean; output: string } {
  try {
    const output = execSync(`"${foundryShPath}" resume-qa "${taskSlug}"`, {
      encoding: "utf-8",
      timeout: 30000,
    });
    return { success: true, output };
  } catch (err: any) {
    return { success: false, output: err.message ?? "unknown error" };
  }
}

/**
 * Find task directory by slug.
 */
export function findTaskDir(tasksRoot: string, slug: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(tasksRoot);
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (entry.startsWith(slug + "--foundry")) {
      return join(tasksRoot, entry);
    }
  }
  return null;
}
