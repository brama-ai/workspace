#!/usr/bin/env bash
#
# Cost tracking and telemetry helpers for Builder and Ultraworks summaries.
#
set -euo pipefail

: "${REPO_ROOT:=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
# shellcheck source=/dev/null
source "$REPO_ROOT/agentic-development/lib/foundry-common.sh"
maybe_migrate_legacy_foundry_tasks
ensure_foundry_task_root

strip_export_json() {
  local src="$1"
  awk 'BEGIN{p=0} /^[[:space:]]*{/ {p=1} p {print}' "$src"
}

export_session_json() {
  local session_id="$1"
  local out_file="$2"
  local raw_file
  raw_file="$(mktemp)"

  if ! opencode export "$session_id" > "$raw_file" 2>/dev/null; then
    rm -f "$raw_file"
    return 1
  fi

  if ! strip_export_json "$raw_file" > "$out_file"; then
    rm -f "$raw_file" "$out_file"
    return 1
  fi

  rm -f "$raw_file"
}

detect_pricing_tier() {
  local model="${1:-}"
  case "$model" in
    anthropic/claude-opus-*) echo "15:75:1.5" ;;
    anthropic/claude-sonnet-*) echo "3:15:0.3" ;;
    anthropic/claude-haiku-*) echo "1:5:0.1" ;;
    openai/gpt-5.4) echo "1.75:14:0.175" ;;
    openai/gpt-5.3-codex|openai/gpt-5.2-codex|openai/gpt-5-codex|openai/gpt-5.1-codex*|openai/codex-mini-latest) echo "1.5:6:0.15" ;;
    openai/gpt-5.2|openai/gpt-5-mini|openai/gpt-5-nano|opencode/gpt-5-nano) echo "1.25:10:0.125" ;;
    google/gemini-3.1-pro-preview|google/gemini-2.5-pro|google/gemini-3-pro-preview) echo "2:12:0.2" ;;
    google/gemini-3-flash-preview|google/gemini-3.1-flash-lite-preview|google/gemini-2.5-flash|google/gemini-2.5-flash-lite) echo "0.3:2.5:0.03" ;;
    minimax/MiniMax-M2.7|minimax/MiniMax-M2.7-highspeed|minimax/MiniMax-M2.5|minimax/MiniMax-M2.5-highspeed|minimax/MiniMax-M2.1|minimax/MiniMax-M2) echo "1.1:8:0" ;;
    opencode-go/glm-5) echo "1.1:8:0" ;;
    opencode-go/kimi-k2.5|openrouter/moonshotai/kimi-k2:free) echo "0.6:2.5:0" ;;
    opencode/big-pickle|opencode/minimax-m2.5-free|opencode/mimo-v2-pro-free|opencode/mimo-v2-omni-free|opencode/nemotron-3-super-free|openrouter/free|openrouter/*:free) echo "0:0:0" ;;
    *) echo "0:0:0" ;;
  esac
}

calculate_cost_from_values() {
  local model="$1" input_tokens="$2" output_tokens="$3" cache_read="$4"
  local pricing in_price out_price cache_price
  pricing="$(detect_pricing_tier "$model")"
  IFS=':' read -r in_price out_price cache_price <<< "$pricing"
  awk -v input="$input_tokens" -v output="$output_tokens" -v cache="$cache_read" \
      -v in_price="$in_price" -v out_price="$out_price" -v cache_price="$cache_price" \
      'BEGIN { printf "%.6f", ((input * in_price) + (output * out_price) + (cache * cache_price)) / 1000000 }'
}

calculate_step_cost() {
  local meta_file="$1"
  local model tokens input_tokens output_tokens cache_read
  
  if [[ ! -f "$meta_file" ]]; then
    echo "0"
    return
  fi
  
  model=$(jq -r '.model // "unknown"' "$meta_file" 2>/dev/null) || model="unknown"
  input_tokens=$(jq -r '.tokens.input // 0' "$meta_file" 2>/dev/null) || echo 0
  output_tokens=$(jq -r '.tokens.output // 0' "$meta_file" 2>/dev/null) || echo 0
  cache_read=$(jq -r '.tokens.cache_read // 0' "$meta_file" 2>/dev/null) || echo 0
  
  calculate_cost_from_values "$model" "$input_tokens" "$output_tokens" "$cache_read"
}

summarize_export_tokens() {
  local export_file="$1"
  jq '{
    input_tokens: [.messages[].info.tokens.input // 0] | add,
    output_tokens: [.messages[].info.tokens.output // 0] | add,
    cache_read: [.messages[].info.tokens.cache.read // 0] | add,
    cache_write: [.messages[].info.tokens.cache.write // 0] | add
  }' "$export_file" 2>/dev/null
}

extract_export_model() {
  local export_file="$1"
  jq -r '
    [
      .messages[]
      | select(.info.role == "assistant")
      | "\(.info.providerID // .info.model.providerID // "unknown")/\(.info.modelID // .info.model.modelID // "unknown")"
    ]
    | map(select(. != "unknown/unknown"))
    | last // "unknown"
  ' "$export_file" 2>/dev/null
}

extract_session_tools() {
  local export_file="$1"
  jq '
    [
      .messages[].parts[]?
      | select(.type == "tool")
      | .tool
      | select(. != null and . != "")
    ]
    | group_by(.)
    | map({name: .[0], count: length})
    | sort_by(.name)
  ' "$export_file" 2>/dev/null
}

# Extract context modifiers that influence LLM behavior:
# - skills loaded (inject agent instructions)
# - MCP tools used (external capabilities)
# - agent prompt file (which .md was loaded as identity)
# Standard file operations (read/edit/write/bash) are excluded.
extract_session_context() {
  local export_file="$1"
  
  if [[ ! -f "$export_file" ]]; then
    echo "{}"
    return
  fi
  
  jq '{
    skills: [.messages[].parts[]? | select(.type == "tool" and .tool == "skill") | .state.input.name // .state.input.skill // empty] | unique,
    mcp_tools: ([.messages[].parts[]? | select(.type == "tool" and (.tool | startswith("mcp__"))) | .tool] | group_by(.) | map({name: .[0], count: length}) | sort_by(.name)),
    claude_commands: [.messages[].parts[]? | select(.type == "tool" and .tool == "slash_command") | .state.input.command // .state.input.name // empty] | unique
  }' "$export_file" 2>/dev/null || echo "{}"
}

extract_session_files_read() {
  local export_file="$1"
  
  if [[ ! -f "$export_file" ]]; then
    echo "[]"
    return
  fi
  
  jq '[
    .messages[].parts[]?
    | select(.type == "tool")
    | select(.tool == "read" or .tool == "grep" or .tool == "glob" or .tool == "list" or .tool == "edit")
    | .state.input
    | (.filePath // .path // empty)
  ] | unique | sort' "$export_file" 2>/dev/null || echo "[]"
}

format_duration_human() {
  local seconds="${1:-0}"
  if [[ "$seconds" -ge 60 ]]; then
    printf "%dm %02ds" "$(( seconds / 60 ))" "$(( seconds % 60 ))"
  else
    printf "%ds" "$seconds"
  fi
}

write_telemetry_record() {
  local out_file="$1" workflow="$2" agent="$3" model="$4" duration_seconds="$5" exit_code="$6" session_id="$7" tokens_json="$8" tools_json="$9" files_json="${10}" step_cost="${11}" context_json="${12:-{}}"
  
  local dir
  dir=$(dirname "$out_file")
  mkdir -p "$dir"
  
  jq -n \
    --arg workflow "$workflow" \
    --arg agent "$agent" \
    --arg model "$model" \
    --argjson duration_seconds "${duration_seconds:-0}" \
    --argjson exit_code "${exit_code:-0}" \
    --arg session_id "$session_id" \
    --argjson tokens "$tokens_json" \
    --argjson tools "$tools_json" \
    --argjson files_read "$files_json" \
    --argjson cost "${step_cost:-0}" \
    --argjson context "$context_json" '
    {
      workflow: $workflow,
      agent: $agent,
      model: $model,
      duration_ms: ($duration_seconds * 1000),
      duration_seconds: $duration_seconds,
      exit_code: $exit_code,
      session_id: $session_id,
      tokens: {
        input_tokens: ($tokens.input_tokens // 0),
        output_tokens: ($tokens.output_tokens // 0),
        cache_read: ($tokens.cache_read // 0),
        cache_write: ($tokens.cache_write // 0)
      },
      tools: $tools,
      files_read: $files_read,
      context: $context,
      cost: $cost
    }
  ' > "$out_file"
}

render_builder_summary_block() {
  local slug="$1"
  local ts_script="$REPO_ROOT/agentic-development/monitor/src/cli/render-summary.ts"
  
  if [[ -f "$ts_script" ]]; then
    REPO_ROOT="$REPO_ROOT" npx tsx "$ts_script" foundry "$slug"
  else
    echo "**Workflow:** Foundry"
    echo ""
    echo "_render-summary.ts not found_"
  fi
}

render_ultraworks_summary_block() {
  local session_id="${1:-}"
  local ts_script="$REPO_ROOT/agentic-development/monitor/src/cli/render-summary.ts"
  
  if [[ -f "$ts_script" ]]; then
    REPO_ROOT="$REPO_ROOT" npx tsx "$ts_script" ultraworks "$session_id"
  else
    echo "**Workflow:** Ultraworks"
    echo ""
    echo "_render-summary.ts not found_"
  fi
}

main() {
  local command="${1:-}"
  shift || true

  case "$command" in
    summary-block)
      local workflow="auto" task_slug="" session_id=""
      while [[ $# -gt 0 ]]; do
        case "$1" in
          --workflow) workflow="$2"; shift 2 ;;
          --task-slug) task_slug="$2"; shift 2 ;;
          --session-id) session_id="$2"; shift 2 ;;
          *) echo "Unknown option: $1" >&2; return 1 ;;
        esac
      done
      local foundry_task_dir=""
      if [[ -n "$task_slug" ]]; then
        foundry_task_dir=$(foundry_task_dir_for_slug "$task_slug" 2>/dev/null || true)
      fi
      if [[ "$workflow" == "builder" || "$workflow" == "foundry" || ( "$workflow" == "auto" && -n "$task_slug" && -n "$foundry_task_dir" && -f "$foundry_task_dir/artifacts/checkpoint.json" ) ]]; then
        render_builder_summary_block "$task_slug"
      else
        render_ultraworks_summary_block "$session_id"
      fi
      ;;
    "")
      ;;
    *)
      echo "Unknown command: $command" >&2
      return 1
      ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
