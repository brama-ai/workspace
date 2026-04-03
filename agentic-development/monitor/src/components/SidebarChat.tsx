import React from "react";
import { Box, Text } from "ink";
import type { ChatSession } from "../state/chat-session.js";
import type { SlashCommand } from "../lib/slash-commands.js";
import type { ModelInventoryEntry } from "../lib/model-inventory.js";
import { AUTO_COMPACT_THRESHOLD } from "../agents/chat-agent.js";

export function SidebarChat({
  session,
  input,
  loading,
  focused,
  slashSuggestions,
  slashSuggestionIdx,
  modelPickerOpen,
  modelPickerIdx,
  healthyModels,
  scrollOffset,
  loadingLabel,
  liveDraft,
  activityLines,
  width,
  rows,
}: {
  session: ChatSession;
  input: string;
  loading: boolean;
  focused: boolean;
  slashSuggestions: SlashCommand[];
  slashSuggestionIdx: number;
  modelPickerOpen: boolean;
  modelPickerIdx: number;
  healthyModels: ModelInventoryEntry[];
  scrollOffset: number;
  loadingLabel: string;
  liveDraft: string;
  activityLines: string[];
  width: number;
  rows: number;
}) {
  const contextK = Math.round(session.contextTokens / 1000);
  const contextPct = Math.min(100, Math.round((session.contextTokens / AUTO_COMPACT_THRESHOLD) * 100));
  const contextColor = contextPct >= 90 ? "red" : contextPct >= 70 ? "yellow" : "green";
  const modelShort = session.model
    ? session.model.replace(/^(anthropic|openai|google|openrouter)\//, "").slice(0, 20)
    : "default";

  type DisplayLine = { text: string; role: "user" | "assistant" | "system" | "activity" | "draft" | "meta" };

  const allMessages = session.messages;
  const historyLines: DisplayLine[] = [];

  function wrapMessage(content: string, role: DisplayLine["role"], prefix = ""): DisplayLine[] {
    const wrapped: DisplayLine[] = [];
    const continuation = " ".repeat(prefix.length);
    const maxContentWidth = Math.max(12, width - prefix.length - 2);

    for (const sourceLine of content.split("\n")) {
      if (sourceLine.length === 0) {
        wrapped.push({ text: prefix, role });
        continue;
      }
      let offset = 0;
      let firstChunk = true;
      while (offset < sourceLine.length) {
        const chunk = sourceLine.slice(offset, offset + maxContentWidth);
        wrapped.push({ text: `${firstChunk ? prefix : continuation}${chunk}`, role });
        firstChunk = false;
        offset += maxContentWidth;
      }
    }

    return wrapped;
  }

  if (session.compactMemory) {
    historyLines.push({ text: "── [compacted memory] ──", role: "meta" });
    historyLines.push({ text: "", role: "meta" });
  }

  for (const msg of allMessages) {
    const role = msg.role === "user" ? "user" : msg.role === "assistant" ? "assistant" : "system";
    const prefix = role === "system" ? "Sys: " : "";
    historyLines.push(...wrapMessage(msg.content, role, prefix));
    historyLines.push({ text: "", role: role === "user" ? "user" : "meta" });
  }

  if (loading && activityLines.length > 0) {
    historyLines.push({ text: "Sys: agent activity", role: "system" });
    for (const line of activityLines) {
      historyLines.push(...wrapMessage(line, "activity", "  · "));
    }
    historyLines.push({ text: "", role: "meta" });
  }

  if (loading && liveDraft.trim()) {
    historyLines.push(...wrapMessage(liveDraft, "draft"));
    historyLines.push({ text: "", role: "meta" });
  }

  const viewportH = rows - 10;
  const maxOffset = Math.max(0, historyLines.length - viewportH);
  const clampedOffset = Math.min(scrollOffset, maxOffset);
  const visibleLines = historyLines.slice(clampedOffset, clampedOffset + viewportH);

  return (
    <Box flexDirection="column" width={width}>
      <Box>
        <Text bold color={focused ? "cyan" : "white"}> Chat</Text>
        <Text dimColor> {modelShort}</Text>
        <Text color={contextColor as any} dimColor> {contextK}k/{Math.round(AUTO_COMPACT_THRESHOLD / 1000)}k</Text>
        {session.watchJobs.length > 0 && (
          <Text color="yellow" dimColor> ⏱{session.watchJobs.length}</Text>
        )}
      </Box>
      <Text dimColor>{"─".repeat(width - 1)}</Text>

      <Box flexDirection="column" height={viewportH}>
        {visibleLines.length === 0 && !session.compactMemory ? (
          <Text dimColor> Type a message or / for commands</Text>
        ) : (
          visibleLines.map((line, i) => {
            const isUser = line.role === "user";
            const isSystem = line.role === "system";
            const isDraft = line.role === "draft";
            const isActivity = line.role === "activity";
            const padded = isUser
              ? `${" ".repeat(Math.max(0, width - 2 - line.text.length))}${line.text}`
              : line.text;
            return (
              <Text
                key={i}
                color={isUser ? "cyan" : isSystem ? "yellow" : isDraft ? "green" : undefined}
                dimColor={!isUser && !isSystem && !isDraft && !isActivity}
              >
                {" " + padded.slice(0, width - 2)}
              </Text>
            );
          })
        )}
        {loading && <Text color="yellow"> ⟳ {loadingLabel || "thinking…"}</Text>}
      </Box>

      {slashSuggestions.length > 0 && (
        <Box flexDirection="column">
          <Text dimColor>{"─".repeat(width - 1)}</Text>
          {slashSuggestions.map((cmd, i) => (
            <Box key={cmd.name}>
              <Text color={i === slashSuggestionIdx ? "cyan" : undefined} dimColor={i !== slashSuggestionIdx}>
                {i === slashSuggestionIdx ? " ▶ " : "   "}
                {cmd.name.padEnd(10)}
              </Text>
              <Text dimColor>{cmd.description.slice(0, width - 14)}</Text>
            </Box>
          ))}
        </Box>
      )}

      {modelPickerOpen && (
        <Box flexDirection="column">
          <Text dimColor>{"─".repeat(width - 1)}</Text>
          <Text bold color="cyan"> Select model (Enter confirm, Esc cancel)</Text>
          {healthyModels.length === 0 ? (
            <Text color="red"> No healthy models available</Text>
          ) : (
            healthyModels.slice(0, 8).map((m, i) => (
              <Box key={m.modelId}>
                <Text color={i === modelPickerIdx ? "cyan" : undefined} dimColor={i !== modelPickerIdx}>
                  {i === modelPickerIdx ? " ▶ " : "   "}
                  {m.modelId.replace(/^(anthropic|openai|google|openrouter)\//, "").slice(0, width - 5)}
                </Text>
              </Box>
            ))
          )}
        </Box>
      )}

      <Text dimColor>{"─".repeat(width - 1)}</Text>
      <Box>
        <Text color={focused ? "cyan" : "white"}>{focused ? "▶ " : "  "}</Text>
        <Text>{input || (focused ? "" : "(Tab to focus)")}</Text>
        {focused && <Text color="cyan">█</Text>}
      </Box>
    </Box>
  );
}
