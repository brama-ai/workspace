import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const execFileSyncMock = vi.fn();

vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock,
}));

import {
  SIDEBAR_CHAT_AGENT,
  buildOperatorPrompt,
  executeChatTurn,
  getChatAgentDefinitionPath,
  hasDedicatedChatAgent,
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
      "## Task Queue\n- Pending: 2",
      session,
      { repoRoot, model: "anthropic/claude-sonnet-4-6", supervisorMdPath: join(repoRoot, "agentic-development", "supervisor.md") },
    );

    expect(prompt).toContain("Use your dedicated Foundry sidebar agent contract");
    expect(prompt).toContain("## Current Monitor Context");
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
});
