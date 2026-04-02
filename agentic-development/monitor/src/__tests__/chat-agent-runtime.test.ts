import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";

const { execFileSyncMock, spawnMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
  spawnMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock,
  spawn: spawnMock,
}));

import {
  SIDEBAR_CHAT_AGENT,
  buildOperatorPrompt,
  executeChatTurn,
  executeChatTurnStreaming,
  getChatAgentDefinitionPath,
  hasDedicatedChatAgent,
  normalizeAssistantResponse,
} from "../agents/chat-agent.js";
import { createSession } from "../state/chat-session.js";

describe("chat-agent runtime", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "foundry-chat-runtime-"));
    mkdirSync(join(repoRoot, ".opencode", "agents"), { recursive: true });
    mkdirSync(join(repoRoot, "agentic-development"), { recursive: true });
    writeFileSync(getChatAgentDefinitionPath(repoRoot), "---\ndescription: test\nmodel: anthropic/claude-sonnet-4-6\n---\n", "utf-8");
    writeFileSync(join(repoRoot, "agentic-development", "supervisor.md"), "# Supervisor\n\nCheck stalled tasks.", "utf-8");
    execFileSyncMock.mockReset();
    execFileSyncMock.mockReturnValue("State: queue moving\nIssues: none\nNext: nothing right now\n");
    spawnMock.mockReset();
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("detects dedicated agent contract file", () => {
    expect(hasDedicatedChatAgent(repoRoot)).toBe(true);
    expect(getChatAgentDefinitionPath(repoRoot)).toContain(`${SIDEBAR_CHAT_AGENT}.md`);
  });

  it("builds operator prompt with context and supervision contract", () => {
    const session = createSession(repoRoot);
    session.compactMemory = "Earlier the queue had one failure.";

    const prompt = buildOperatorPrompt(
      "why are tasks pending?",
      session,
      { repoRoot, model: "anthropic/claude-sonnet-4-6", supervisorMdPath: join(repoRoot, "agentic-development", "supervisor.md") },
      {
        assembledAt: new Date().toISOString(),
        selectedTaskSlug: "my-task",
        counts: { todo: 0, pending: 2, in_progress: 0, waiting_answer: 0, completed: 0, failed: 0, suspended: 0 },
        tasks: [],
        processes: { workerCount: 0, zombieCount: 0, hasStalelock: false, workerPids: [] },
        models: { totalModels: 1, healthyModels: ["anthropic/claude-sonnet-4-6"], blacklistedModels: [] },
      },
    );

    expect(prompt).toContain("Use your dedicated Foundry sidebar agent contract");
    expect(prompt).toContain("./agentic-development/foundry snapshot --json --task my-task");
    expect(prompt).toContain("## Previous Conversation Summary");
    expect(prompt).toContain("## Supervision Contract");
    expect(prompt).toContain("why are tasks pending?");
  });

  it("executes opencode with dedicated agent name", () => {
    const session = createSession(repoRoot);
    const response = executeChatTurn(
      "why are tasks pending?",
      "## Task Queue\n- Pending: 2",
      session,
      { repoRoot, model: "anthropic/claude-sonnet-4-6", supervisorMdPath: join(repoRoot, "agentic-development", "supervisor.md") },
    );

    expect(response).toContain("State:");
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    expect(execFileSyncMock.mock.calls[0][0]).toBe("opencode");
    expect(execFileSyncMock.mock.calls[0][1]).toContain("--agent");
    expect(execFileSyncMock.mock.calls[0][1]).toContain(SIDEBAR_CHAT_AGENT);
  });

  it("normalizes unstructured answers into state issues next format", () => {
    const normalized = normalizeAssistantResponse("## Pending queue looks blocked\nNo worker is active right now.", {
      assembledAt: new Date().toISOString(),
      selectedTaskSlug: null,
      counts: {
        todo: 0,
        pending: 2,
        in_progress: 0,
        waiting_answer: 0,
        completed: 0,
        failed: 0,
        suspended: 0,
      },
      tasks: [],
      processes: {
        workerCount: 0,
        zombieCount: 0,
        hasStalelock: false,
        workerPids: [],
      },
      models: {
        totalModels: 1,
        healthyModels: ["anthropic/claude-sonnet-4-6"],
        blacklistedModels: [],
      },
    });

    expect(normalized).toContain("State:");
    expect(normalized).toContain("Issues:");
    expect(normalized).toContain("Next:");
    expect(normalized).toContain("no active worker");
  });

  it("preserves rich formatted answers and appends next action", () => {
    const normalized = normalizeAssistantResponse("## Queue status\n\n- Pending: 2\n- Workers: 0\n- Waiting tasks: none", {
      assembledAt: new Date().toISOString(),
      selectedTaskSlug: null,
      counts: {
        todo: 0,
        pending: 2,
        in_progress: 0,
        waiting_answer: 0,
        completed: 0,
        failed: 0,
        suspended: 0,
      },
      tasks: [],
      processes: {
        workerCount: 0,
        zombieCount: 0,
        hasStalelock: false,
        workerPids: [],
      },
      models: {
        totalModels: 1,
        healthyModels: ["anthropic/claude-sonnet-4-6"],
        blacklistedModels: [],
      },
    });

    expect(normalized).toContain("## Queue status");
    expect(normalized).toContain("- Pending: 2");
    expect(normalized).toContain("Next:");
  });

  it("streams agent activity and partial text", async () => {
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    spawnMock.mockReturnValue(child);

    const activity: string[] = [];
    const chunks: string[] = [];
    const session = createSession(repoRoot);

    const promise = executeChatTurnStreaming(
      "why are tasks pending?",
      "ignored",
      session,
      { repoRoot, model: "anthropic/claude-sonnet-4-6", supervisorMdPath: join(repoRoot, "agentic-development", "supervisor.md") },
      undefined,
      {
        onActivity: (line) => activity.push(line),
        onText: (text) => chunks.push(text),
      },
    );

    child.stderr.emit("data", "reading snapshot\nchecking handoff\n");
    child.stdout.emit("data", "State: queue blocked\n");
    child.stdout.emit("data", "Issues: no active worker\nNext: start headless\n");
    child.emit("close", 0);

    const response = await promise;
    expect(activity[0]).toContain("launching");
    expect(activity).toContain("reading snapshot");
    expect(chunks[chunks.length - 1]).toContain("Next: start headless");
    expect(response).toContain("State: queue blocked");
  });
});
