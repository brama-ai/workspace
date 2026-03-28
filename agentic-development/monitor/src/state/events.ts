import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { env } from "node:process";
import { fileURLToPath } from "node:url";

export type EventType =
  | "AGENT_START"
  | "AGENT_END"
  | "AGENT_FALLBACK"
  | "AGENT_RETRY"
  | "AGENT_LOOP"
  | "AGENT_STALL"
  | "PIPELINE_START"
  | "PIPELINE_END"
  | "PIPELINE_PAUSE"
  | "PIPELINE_RESUME"
  | "TASK_WAITING"
  | "TASK_RESUMED"
  | "HITL_QUESTION"
  | "HITL_ANSWER"
  | "CHECKPOINT"
  | "ERROR";

export interface PipelineEvent {
  ts: string;
  epoch: number;
  type: EventType;
  details: Record<string, string | number | boolean>;
}

let eventsLogPath: string | null = null;

export function initEventsLog(pipelineDir: string): void {
  eventsLogPath = join(pipelineDir, "events.log");
  const dir = dirname(eventsLogPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function getEventsLogPath(): string | null {
  return eventsLogPath;
}

export function emitEvent(type: EventType, details: Record<string, string | number | boolean> = {}): void {
  if (!eventsLogPath) {
    return;
  }

  const now = new Date();
  const ts = now.toTimeString().slice(0, 8);
  const epoch = Math.floor(now.getTime() / 1000);

  const detailsStr = Object.entries(details)
    .map(([k, v]) => `${k}=${v}`)
    .join("|");

  const line = `${epoch}|${ts}|${type}|${detailsStr}\n`;

  try {
    appendFileSync(eventsLogPath, line, "utf8");
  } catch (err) {
    console.error(`[events] ERROR: failed to write event ${type} to ${eventsLogPath}: ${err}`);
  }
}

export function parseEventLine(line: string): PipelineEvent | null {
  const parts = line.trim().split("|");
  if (parts.length < 3) return null;

  const [epochStr, ts, type, ...detailParts] = parts;
  const epoch = parseInt(epochStr, 10);
  if (isNaN(epoch)) return null;

  const details: Record<string, string | number | boolean> = {};
  for (const part of detailParts) {
    const eqIdx = part.indexOf("=");
    if (eqIdx > 0) {
      const key = part.slice(0, eqIdx);
      const value = part.slice(eqIdx + 1);
      if (value === "true") details[key] = true;
      else if (value === "false") details[key] = false;
      else if (/^\d+$/.test(value)) details[key] = parseInt(value, 10);
      else if (/^\d+\.\d+$/.test(value)) details[key] = parseFloat(value);
      else details[key] = value;
    }
  }

  return { ts, epoch, type: type as EventType, details };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;

if (isMain || env.NODE_ENV === "test") {
  const args = process.argv.slice(2);
  if (args[0] === "emit" && args[1] && args[2]) {
    const pipelineDir = env.PIPELINE_DIR || process.cwd();
    initEventsLog(pipelineDir);
    const type = args[1] as EventType;
    const details: Record<string, string> = {};
    for (let i = 2; i < args.length; i++) {
      const [k, v] = args[i].split("=");
      if (k && v !== undefined) {
        details[k] = v;
      }
    }
    emitEvent(type, details);
  }
}
