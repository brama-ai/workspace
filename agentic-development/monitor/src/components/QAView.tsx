import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { TaskInfo, QAQuestion } from "../lib/tasks.js";

export function QAView({ task, cols, rows, onBack }: { task: TaskInfo; cols: number; rows: number; onBack: () => void }) {
  const questions: QAQuestion[] = task.qaData?.questions ?? [];
  const [selectedQ, setSelectedQ] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const q of questions) {
      if (q.answer) init[q.id] = q.answer;
    }
    return init;
  });
  const [focusPanel, setFocusPanel] = useState<"list" | "editor">("list");
  const [answerText, setAnswerText] = useState("");
  const [saved, setSaved] = useState(false);

  const currentQ = questions[selectedQ];

  useEffect(() => {
    if (currentQ) {
      setAnswerText(answers[currentQ.id] ?? "");
    }
  }, [selectedQ, currentQ?.id]);

  const saveAnswers = () => {
    if (!currentQ) return;
    const updated = { ...answers, [currentQ.id]: answerText };
    setAnswers(updated);

    const qaPath = join(task.dir, "qa.json");
    try {
      const data = existsSync(qaPath) ? JSON.parse(readFileSync(qaPath, "utf-8")) : { version: 1, questions: [] };
      for (const q of data.questions) {
        if (updated[q.id] !== undefined && updated[q.id] !== "") {
          q.answer = updated[q.id];
          q.answered_at = new Date().toISOString();
          q.answered_by = "human";
          q.answer_source = "tui";
        }
      }
      writeFileSync(qaPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {}
  };

  const leftW = Math.floor(cols * 0.45);
  const rightW = cols - leftW - 3;
  const listH = rows - 10;

  if (questions.length === 0) {
    return (
      <Box flexDirection="column">
        <Text bold color="cyan">  Q&A: {task.title.slice(0, 50)}</Text>
        <Text> </Text>
        <Text dimColor>  No questions found in qa.json</Text>
        <Text> </Text>
        <Text dimColor>  Esc back</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color="cyan">  Q&A: </Text>
        <Text>{task.title.slice(0, 40)}</Text>
        {saved && <Text color="green"> ✓ saved</Text>}
      </Box>
      <Text dimColor>{"  " + "─".repeat(cols - 4)}</Text>

      <Box>
        {/* Left: question list */}
        <Box flexDirection="column" width={leftW}>
          <Text bold dimColor>  Questions ({questions.length})</Text>
          <Text dimColor>  {"─".repeat(leftW - 4)}</Text>
          {questions.slice(0, listH).map((q, i) => {
            const isCurrent = i === selectedQ;
            const isAnswered = !!(answers[q.id] || q.answer);
            const isBlocking = q.priority === "blocking";
            const marker = isAnswered ? "✓" : isBlocking ? "*" : "·";
            const color = isAnswered ? "green" : isBlocking ? "red" : undefined;
            const agentShort = q.agent.replace("u-", "");
            return (
              <Box key={q.id}>
                <Text color="cyan">{isCurrent ? "  ► " : "    "}</Text>
                <Text color={color as any}>{marker} </Text>
                <Text bold={isCurrent} dimColor={!isCurrent && isAnswered}>
                  {q.id} [{q.priority === "blocking" ? "B" : "N"}] {agentShort}
                </Text>
              </Box>
            );
          })}
        </Box>

        {/* Divider */}
        <Box flexDirection="column">
          {Array.from({ length: Math.min(listH + 3, rows - 6) }).map((_, i) => (
            <Text key={i} dimColor>│</Text>
          ))}
        </Box>

        {/* Right: question detail + answer editor */}
        <Box flexDirection="column" width={rightW}>
          {currentQ ? (
            <>
              <Text bold>{" Q" + (selectedQ + 1) + " [" + currentQ.priority + "]"}</Text>
              <Text dimColor>{" " + "─".repeat(rightW - 2)}</Text>
              <Text>{" " + currentQ.question.slice(0, rightW - 2)}</Text>
              {currentQ.context && <Text dimColor>{" 📎 " + currentQ.context.slice(0, rightW - 5)}</Text>}
              {currentQ.options && currentQ.options.length > 0 && (
                <Box flexDirection="column">
                  <Text dimColor>{" Options:"}</Text>
                  {currentQ.options.map((opt, oi) => (
                    <Text key={oi} dimColor>{`  ${oi + 1}. ${opt}`}</Text>
                  ))}
                </Box>
              )}
              <Text> </Text>
              <Text bold color={focusPanel === "editor" ? "cyan" : undefined}>{" Answer:"}</Text>
              <Box borderStyle={focusPanel === "editor" ? "single" : undefined} borderColor="cyan">
                <Text>{" " + (answerText || "(type your answer)")}</Text>
              </Box>
              {answers[currentQ.id] && (
                <Text color="green">{" ✓ Saved: " + answers[currentQ.id].slice(0, rightW - 12)}</Text>
              )}
            </>
          ) : (
            <Text dimColor>  Select a question</Text>
          )}
        </Box>
      </Box>

      <Text dimColor>{"  " + "─".repeat(cols - 4)}</Text>
      <Text dimColor>  * = blocking  ✓ = answered  ► = selected  Tab: switch panel  Esc: save & back  Ctrl+S: save</Text>
    </Box>
  );
}
