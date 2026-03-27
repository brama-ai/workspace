/**
 * Formats Q&A questions as Telegram messages with inline keyboards.
 */

import { InlineKeyboard } from "grammy";

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

export interface FormattedQuestion {
  text: string;
  keyboard: InlineKeyboard;
}

/**
 * Format a single question as a Telegram message with inline keyboard.
 */
export function formatQuestion(
  q: Question,
  taskSlug: string,
  index: number,
  total: number
): FormattedQuestion {
  const priorityIcon = q.priority === "blocking" ? "🔴" : "🟡";
  const answeredIcon = q.answer ? "✅" : "❓";

  const lines: string[] = [
    `${answeredIcon} <b>Q${index + 1}/${total}</b> ${priorityIcon} [${q.priority}]`,
    `<b>${escapeHtml(q.question)}</b>`,
  ];

  if (q.context) {
    lines.push(`📎 <i>${escapeHtml(q.context)}</i>`);
  }

  if (q.answer) {
    lines.push(``, `✅ <b>Answered by ${q.answered_by ?? "human"}:</b>`);
    lines.push(escapeHtml(q.answer));
  }

  lines.push(``, `📋 Task: <code>${taskSlug}</code>`);

  const text = lines.join("\n");

  const keyboard = new InlineKeyboard();

  if (!q.answer) {
    // Add option buttons if available
    if (q.options && q.options.length > 0) {
      for (let i = 0; i < q.options.length; i++) {
        const opt = q.options[i];
        const shortOpt = opt.length > 30 ? opt.slice(0, 27) + "..." : opt;
        keyboard.text(shortOpt, `answer:${taskSlug}:${q.id}:${i}`).row();
      }
    }
    keyboard.text("📝 Type custom answer", `custom:${taskSlug}:${q.id}`);
  }

  return { text, keyboard };
}

/**
 * Format a summary of all questions for a task.
 */
export function formatTaskSummary(
  taskSlug: string,
  questions: Question[],
  waitingAgent: string
): string {
  const total = questions.length;
  const answered = questions.filter((q) => q.answer !== null).length;
  const blocking = questions.filter((q) => q.priority === "blocking" && !q.answer).length;

  const lines: string[] = [
    `❓ <b>${waitingAgent}</b> needs your input`,
    `📋 <code>${taskSlug}</code>`,
    ``,
    `📊 ${answered}/${total} answered${blocking > 0 ? ` | 🔴 ${blocking} blocking` : ""}`,
    ``,
  ];

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const icon = q.answer ? "✅" : q.priority === "blocking" ? "🔴" : "🟡";
    lines.push(`${icon} Q${i + 1}: ${escapeHtml(q.question.slice(0, 60))}${q.question.length > 60 ? "..." : ""}`);
  }

  return lines.join("\n");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
