/**
 * slash-commands.ts — Command registry, filtering, and suggestion UX logic for sidebar chat.
 *
 * When the operator types "/" in the sidebar input, this module provides
 * filtered command suggestions. Commands are inline-first: suggestions appear
 * as the operator types.
 */
import { env } from "node:process";

const DEBUG = env.FOUNDRY_DEBUG === "true";

function debug(...args: unknown[]): void {
  if (!DEBUG) return;
  const ts = new Date().toISOString().split("T")[1].slice(0, 12);
  console.error(`[${ts}] [slash-commands]`, ...args);
}

// ── Types ─────────────────────────────────────────────────────────

export interface SlashCommand {
  /** Command name including leading slash, e.g. "/model" */
  name: string;
  /** Short description shown in suggestion list */
  description: string;
  /** Category for grouping */
  category: "session" | "context" | "model";
}

// ── Command registry ──────────────────────────────────────────────

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: "/model",
    description: "Switch the active chat model (opens picker with healthy models)",
    category: "model",
  },
  {
    name: "/compact",
    description: "Compress chat history into compact memory and continue in same session",
    category: "context",
  },
  {
    name: "/new",
    description: "Start a fresh chat session (previous session is preserved)",
    category: "session",
  },
];

// ── Filtering ─────────────────────────────────────────────────────

/**
 * Get slash command suggestions for the given input.
 *
 * Rules:
 * - Empty input → no suggestions
 * - "/" alone → all commands
 * - "/mo" → commands starting with "/mo"
 * - "/x" → no matches
 * - Non-slash input → no suggestions
 */
export function getSlashSuggestions(input: string): SlashCommand[] {
  if (!input || !input.startsWith("/")) {
    debug("no suggestions — input does not start with /");
    return [];
  }

  const query = input.toLowerCase();

  if (query === "/") {
    debug("showing all commands");
    return [...SLASH_COMMANDS];
  }

  const matches = SLASH_COMMANDS.filter((cmd) =>
    cmd.name.toLowerCase().startsWith(query),
  );

  debug("suggestions for", JSON.stringify(input), "→", matches.map((c) => c.name));
  return matches;
}

/**
 * Check if the input is an exact slash command match.
 * Returns the command or null.
 */
export function matchSlashCommand(input: string): SlashCommand | null {
  const trimmed = input.trim().toLowerCase();
  return SLASH_COMMANDS.find((cmd) => cmd.name.toLowerCase() === trimmed) ?? null;
}

/**
 * Check if the input starts with a slash (potential command).
 */
export function isSlashInput(input: string): boolean {
  return input.startsWith("/");
}
