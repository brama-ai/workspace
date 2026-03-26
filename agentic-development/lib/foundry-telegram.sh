#!/usr/bin/env bash
#
# Foundry Telegram notification helpers — shell-level, curl-based.
# Provides one-way notifications for HITL events.
# Does NOT depend on the telegram-qa Node.js bot.
#
# Usage: source this file, then call send_telegram_* functions.
# Requires: PIPELINE_TELEGRAM_BOT_TOKEN and PIPELINE_TELEGRAM_CHAT_ID env vars.
#
# All functions are silent (no output) when Telegram is not configured.
#

# ── Core send function ────────────────────────────────────────────────

_foundry_telegram_send() {
  local message="$1"
  local bot_token="${PIPELINE_TELEGRAM_BOT_TOKEN:-}"
  local chat_id="${PIPELINE_TELEGRAM_CHAT_ID:-}"

  if [[ -z "$bot_token" || -z "$chat_id" ]]; then
    return 0  # Silently skip — not configured
  fi

  curl -s -X POST "https://api.telegram.org/bot${bot_token}/sendMessage" \
    -d "chat_id=${chat_id}" \
    -d "parse_mode=HTML" \
    -d "text=${message}" \
    -d "disable_web_page_preview=true" \
    &>/dev/null || true
}

# ── HITL Event Notifications ──────────────────────────────────────────

# Called when an agent exits with code 75 (waiting_answer)
# Args: agent, task_slug, question_count
send_telegram_hitl_waiting() {
  local agent="${1:-unknown}"
  local task_slug="${2:-unknown}"
  local q_count="${3:-?}"

  _foundry_telegram_send "❓ <b>${agent}</b> needs your input
📋 ${task_slug}
🔢 ${q_count} question(s)

Use: <code>foundry.sh answer ${task_slug}</code>"
}

# Called when all questions are answered and pipeline is resuming
# Args: task_slug, resume_agent
send_telegram_hitl_answered() {
  local task_slug="${1:-unknown}"
  local resume_agent="${2:-unknown}"

  _foundry_telegram_send "✅ Questions answered for <b>${task_slug}</b>
Resuming from ${resume_agent}..."
}

# Called when wait timeout is approaching
# Args: task_slug, duration_human (e.g. "2h"), unanswered_count, percent (50 or 90)
send_telegram_hitl_timeout_warning() {
  local task_slug="${1:-unknown}"
  local duration="${2:-unknown}"
  local unanswered="${3:-?}"
  local percent="${4:-50}"

  _foundry_telegram_send "⏰ <b>${task_slug}</b> waiting for ${duration} — ${unanswered} unanswered question(s)
(${percent}% of timeout reached)"
}

# Called when wait timeout expires
# Args: task_slug, on_timeout_action (fail|skip|fallback)
send_telegram_hitl_timeout_expired() {
  local task_slug="${1:-unknown}"
  local action="${2:-fail}"

  _foundry_telegram_send "⏰ Pipeline TIMED OUT waiting for answers
📋 <b>${task_slug}</b>
Action: ${action}

Resume later: <code>foundry.sh resume-qa ${task_slug}</code>"
}

# Called when agent-to-agent Q&A resolves questions internally
# Args: answering_agent, asking_agent, task_slug
send_telegram_hitl_agent_resolved() {
  local answering_agent="${1:-unknown}"
  local asking_agent="${2:-unknown}"
  local task_slug="${3:-unknown}"

  _foundry_telegram_send "🤖 <b>${answering_agent}</b> answered <b>${asking_agent}</b>'s question internally
📋 ${task_slug}"
}

# Called when agent-to-agent Q&A partially resolves and escalates to human
# Args: agent, task_slug, answered_count, total_count
send_telegram_hitl_escalated() {
  local agent="${1:-unknown}"
  local task_slug="${2:-unknown}"
  local answered="${3:-0}"
  local total="${4:-?}"

  _foundry_telegram_send "❓ <b>${agent}</b> question escalated to human
📋 ${task_slug}
${answered}/${total} questions resolved by agent

Use: <code>foundry.sh answer ${task_slug}</code>"
}
