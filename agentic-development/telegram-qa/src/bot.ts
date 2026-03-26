/**
 * Foundry Telegram Q&A Bot
 *
 * Standalone Grammy-based bot for bidirectional Q&A between the Foundry pipeline
 * and human operators via Telegram.
 *
 * Usage:
 *   node dist/bot.js --tasks-root /path/to/tasks --foundry-sh /path/to/foundry.sh
 *
 * Required env vars:
 *   PIPELINE_TELEGRAM_BOT_TOKEN  — Telegram bot token from @BotFather
 *   PIPELINE_TELEGRAM_CHAT_ID    — Chat/group ID to post to
 *
 * Optional env vars:
 *   PIPELINE_TELEGRAM_ALLOWED_USERS — Comma-separated user IDs allowed to answer
 */

import { Bot, InlineKeyboard, Context } from "grammy";
import { parseArgs } from "node:util";
import {
  findWaitingTasks,
  readQA,
  writeAnswer,
  allBlockingAnswered,
  triggerResumeQA,
  findTaskDir,
  type WaitingTask,
} from "./qa-bridge.js";
import { formatQuestion, formatTaskSummary } from "./formatter.js";

// ── CLI args ──────────────────────────────────────────────────────────

const { values: args } = parseArgs({
  options: {
    "tasks-root": { type: "string" },
    "foundry-sh": { type: "string" },
  },
  allowPositionals: true,
});

const TASKS_ROOT = args["tasks-root"] ?? process.env.PIPELINE_TASKS_ROOT ?? "./tasks";
const FOUNDRY_SH = args["foundry-sh"] ?? process.env.FOUNDRY_SH ?? "./agentic-development/foundry.sh";

// ── Config ────────────────────────────────────────────────────────────

const BOT_TOKEN = process.env.PIPELINE_TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.PIPELINE_TELEGRAM_CHAT_ID;
const ALLOWED_USERS_RAW = process.env.PIPELINE_TELEGRAM_ALLOWED_USERS ?? "";
const ALLOWED_USERS = ALLOWED_USERS_RAW
  ? ALLOWED_USERS_RAW.split(",").map((s) => parseInt(s.trim(), 10)).filter(Boolean)
  : [];

const IDLE_TIMEOUT_MS = parseInt(process.env.PIPELINE_TG_IDLE_TIMEOUT ?? "1800000", 10); // 30 min

if (!BOT_TOKEN) {
  console.error("Error: PIPELINE_TELEGRAM_BOT_TOKEN is not set");
  process.exit(1);
}

// ── Bot setup ─────────────────────────────────────────────────────────

const bot = new Bot(BOT_TOKEN);

// Session: track pending custom answer state per user
const pendingCustomAnswer: Map<number, { taskSlug: string; questionId: string }> = new Map();

// Idle timer
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    console.log("Idle timeout reached — shutting down");
    bot.stop();
    process.exit(0);
  }, IDLE_TIMEOUT_MS);
}

// ── Auth middleware ───────────────────────────────────────────────────

function isAllowed(ctx: Context): boolean {
  if (ALLOWED_USERS.length === 0) return true; // No restriction
  const userId = ctx.from?.id;
  if (!userId) return false;
  return ALLOWED_USERS.includes(userId);
}

// ── Notification: send waiting task to chat ───────────────────────────

async function notifyWaitingTask(task: WaitingTask) {
  if (!CHAT_ID) return;

  const summary = formatTaskSummary(task.slug, task.questions, task.waitingAgent);
  const keyboard = new InlineKeyboard();
  keyboard.text("📋 View questions", `view:${task.slug}`);

  try {
    await bot.api.sendMessage(CHAT_ID, summary, {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
  } catch (err) {
    console.error("Failed to send notification:", err);
  }
}

// ── Polling: check for new waiting tasks ─────────────────────────────

let knownWaitingTasks = new Set<string>();

async function pollWaitingTasks() {
  const tasks = findWaitingTasks(TASKS_ROOT);
  for (const task of tasks) {
    if (!knownWaitingTasks.has(task.slug)) {
      knownWaitingTasks.add(task.slug);
      await notifyWaitingTask(task);
      resetIdleTimer();
    }
  }
  // Remove tasks that are no longer waiting
  for (const slug of knownWaitingTasks) {
    const stillWaiting = tasks.some((t) => t.slug === slug);
    if (!stillWaiting) {
      knownWaitingTasks.delete(slug);
    }
  }
}

// ── Command handlers ──────────────────────────────────────────────────

bot.command("start", async (ctx) => {
  if (!isAllowed(ctx)) return;
  await ctx.reply(
    "👋 Foundry Q&A Bot\n\nI notify you when pipeline agents need your input.\n\n" +
    "Commands:\n/waiting — list tasks waiting for answers\n/status — pipeline status"
  );
});

bot.command("waiting", async (ctx) => {
  if (!isAllowed(ctx)) return;
  resetIdleTimer();

  const tasks = findWaitingTasks(TASKS_ROOT);
  if (tasks.length === 0) {
    await ctx.reply("✅ No tasks waiting for answers.");
    return;
  }

  for (const task of tasks) {
    const summary = formatTaskSummary(task.slug, task.questions, task.waitingAgent);
    const keyboard = new InlineKeyboard();
    keyboard.text("📋 View questions", `view:${task.slug}`);
    await ctx.reply(summary, { parse_mode: "HTML", reply_markup: keyboard });
  }
});

bot.command("status", async (ctx) => {
  if (!isAllowed(ctx)) return;
  resetIdleTimer();

  const tasks = findWaitingTasks(TASKS_ROOT);
  const lines = [`📊 Pipeline Status`, ``];
  if (tasks.length === 0) {
    lines.push("✅ No tasks waiting for answers");
  } else {
    lines.push(`❓ ${tasks.length} task(s) waiting:`);
    for (const t of tasks) {
      const answered = t.questions.filter((q) => q.answer !== null).length;
      lines.push(`  • ${t.slug}: ${answered}/${t.questions.length} answered`);
    }
  }
  await ctx.reply(lines.join("\n"));
});

// ── Callback query handlers ───────────────────────────────────────────

bot.callbackQuery(/^view:(.+)$/, async (ctx) => {
  if (!isAllowed(ctx)) { await ctx.answerCallbackQuery("Not authorized"); return; }
  resetIdleTimer();

  const taskSlug = ctx.match[1];
  const taskDir = findTaskDir(TASKS_ROOT, taskSlug);
  if (!taskDir) {
    await ctx.answerCallbackQuery("Task not found");
    return;
  }

  const qa = readQA(taskDir);
  if (!qa) {
    await ctx.answerCallbackQuery("No Q&A data found");
    return;
  }

  await ctx.answerCallbackQuery();

  // Send each question as a separate message
  for (let i = 0; i < qa.questions.length; i++) {
    const q = qa.questions[i];
    const { text, keyboard } = formatQuestion(q, taskSlug, i, qa.questions.length);
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
  }
});

bot.callbackQuery(/^answer:([^:]+):([^:]+):(\d+)$/, async (ctx) => {
  if (!isAllowed(ctx)) { await ctx.answerCallbackQuery("Not authorized"); return; }
  resetIdleTimer();

  const [, taskSlug, questionId, optionIndexStr] = ctx.match;
  const optionIndex = parseInt(optionIndexStr, 10);

  const taskDir = findTaskDir(TASKS_ROOT, taskSlug);
  if (!taskDir) {
    await ctx.answerCallbackQuery("Task not found");
    return;
  }

  const qa = readQA(taskDir);
  if (!qa) {
    await ctx.answerCallbackQuery("No Q&A data found");
    return;
  }

  const question = qa.questions.find((q) => q.id === questionId);
  if (!question || !question.options || optionIndex >= question.options.length) {
    await ctx.answerCallbackQuery("Invalid option");
    return;
  }

  const answer = question.options[optionIndex];
  const answeredBy = ctx.from?.username ?? ctx.from?.first_name ?? "human";

  const success = writeAnswer(taskDir, questionId, answer, answeredBy, "telegram");
  if (!success) {
    await ctx.answerCallbackQuery("Failed to save answer");
    return;
  }

  await ctx.answerCallbackQuery(`✅ Answered: ${answer.slice(0, 30)}`);
  await ctx.editMessageText(
    `✅ <b>Q${questionId}</b> answered by ${answeredBy}:\n${answer}`,
    { parse_mode: "HTML" }
  );

  // Check if all blocking questions are answered
  const updatedQA = readQA(taskDir);
  if (updatedQA && allBlockingAnswered(updatedQA.questions)) {
    const result = triggerResumeQA(FOUNDRY_SH, taskSlug);
    if (result.success) {
      await ctx.reply(`✅ All blocking questions answered!\nResuming pipeline for <b>${taskSlug}</b>...`, {
        parse_mode: "HTML",
      });
    } else {
      await ctx.reply(`⚠️ All blocking questions answered but resume failed:\n<code>${result.output}</code>`, {
        parse_mode: "HTML",
      });
    }
  }
});

bot.callbackQuery(/^custom:([^:]+):([^:]+)$/, async (ctx) => {
  if (!isAllowed(ctx)) { await ctx.answerCallbackQuery("Not authorized"); return; }
  resetIdleTimer();

  const [, taskSlug, questionId] = ctx.match;
  const userId = ctx.from?.id;
  if (!userId) { await ctx.answerCallbackQuery("Cannot identify user"); return; }

  pendingCustomAnswer.set(userId, { taskSlug, questionId });
  await ctx.answerCallbackQuery("Type your answer as a reply");
  await ctx.reply(`📝 Type your answer for question <b>${questionId}</b> in task <code>${taskSlug}</code>:`, {
    parse_mode: "HTML",
  });
});

// ── Text message handler (for custom answers) ─────────────────────────

bot.on("message:text", async (ctx) => {
  if (!isAllowed(ctx)) return;
  resetIdleTimer();

  const userId = ctx.from?.id;
  if (!userId) return;

  const pending = pendingCustomAnswer.get(userId);
  if (!pending) return; // Not waiting for a custom answer

  pendingCustomAnswer.delete(userId);

  const { taskSlug, questionId } = pending;
  const taskDir = findTaskDir(TASKS_ROOT, taskSlug);
  if (!taskDir) {
    await ctx.reply("❌ Task not found: " + taskSlug);
    return;
  }

  const answer = ctx.message.text;
  const answeredBy = ctx.from?.username ?? ctx.from?.first_name ?? "human";

  const success = writeAnswer(taskDir, questionId, answer, answeredBy, "telegram");
  if (!success) {
    await ctx.reply("❌ Failed to save answer");
    return;
  }

  await ctx.reply(`✅ Answer saved for <b>${questionId}</b>:\n${answer}`, { parse_mode: "HTML" });

  // Check if all blocking questions are answered
  const updatedQA = readQA(taskDir);
  if (updatedQA && allBlockingAnswered(updatedQA.questions)) {
    const result = triggerResumeQA(FOUNDRY_SH, taskSlug);
    if (result.success) {
      await ctx.reply(`✅ All blocking questions answered!\nResuming pipeline for <b>${taskSlug}</b>...`, {
        parse_mode: "HTML",
      });
    } else {
      await ctx.reply(`⚠️ All blocking questions answered but resume failed:\n<code>${result.output}</code>`, {
        parse_mode: "HTML",
      });
    }
  }
});

// ── Start bot ─────────────────────────────────────────────────────────

console.log(`Foundry Telegram Q&A Bot starting...`);
console.log(`Tasks root: ${TASKS_ROOT}`);
console.log(`Foundry sh: ${FOUNDRY_SH}`);
console.log(`Idle timeout: ${IDLE_TIMEOUT_MS / 1000}s`);
if (ALLOWED_USERS.length > 0) {
  console.log(`Allowed users: ${ALLOWED_USERS.join(", ")}`);
}

// Start polling for waiting tasks every 30 seconds
setInterval(pollWaitingTasks, 30000);
pollWaitingTasks(); // Initial check

resetIdleTimer();

bot.start({
  onStart: () => console.log("Bot is running"),
});
