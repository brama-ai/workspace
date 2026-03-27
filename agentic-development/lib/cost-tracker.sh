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
  local task_dir
  task_dir=$(foundry_task_dir_for_slug "$slug" 2>/dev/null || true)
  [[ -n "$task_dir" ]] || task_dir="$FOUNDRY_TASK_ROOT/${slug}--foundry"
  local artifacts_dir="$task_dir/artifacts"
  local checkpoint_file="$artifacts_dir/checkpoint.json"
  local telemetry_dir="$artifacts_dir/telemetry"
  
  [[ -f "$checkpoint_file" ]] || { echo "No checkpoint file found"; return 1; }
  
  local workflow
  workflow=$(jq -r '.workflow // "builder" | ascii_upcase[:1] + .[1:]' "$checkpoint_file" 2>/dev/null) || workflow="Builder"
  
  echo "**Workflow:** $workflow"
  echo ""
  echo "## Telemetry"
  echo ""
  echo "| Agent | Model | Input | Output | Price | Time |"
  echo "|-------|-------|------:|-------:|------:|-----:|"
  
  local total_cost=0 total_input=0 total_output=0
  
  for tfile in "$telemetry_dir"/*.json; do
    [[ -f "$tfile" ]] || continue
    local agent model input output cost duration
    agent=$(jq -r '.agent // "—"' "$tfile")
    model=$(jq -r '.model // "—"' "$tfile")
    input=$(jq -r '.tokens.input_tokens // 0' "$tfile")
    output=$(jq -r '.tokens.output_tokens // 0' "$tfile")
    cost=$(jq -r '.cost // 0' "$tfile")
    duration=$(jq -r '.duration_seconds // 0' "$tfile")
    
    local dur_str="${duration}s"
    if [[ "$duration" -ge 60 ]]; then
      dur_str="$((duration / 60))m $((duration % 60))s"
    fi
    
    printf "| %s | %s | %s | %s | \$%.4f | %s |\n" "$agent" "$model" "$input" "$output" "$cost" "$dur_str"
    
    total_cost=$(awk "BEGIN{print $total_cost + $cost}")
    total_input=$((total_input + input))
    total_output=$((total_output + output))
  done
  
  echo ""
  printf "**Total:** Input=%s Output=%s Cost=\$%.4f\n" "$total_input" "$total_output" "$total_cost"
}

render_ultraworks_summary_block() {
  local session_id="${1:-}"
  python3 - "$session_id" <<'PYEOF'
import json, os, subprocess, sys, tempfile

repo_root = os.getcwd()
session_id = sys.argv[1]

def export_json(sid):
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".json")
    tmp.close()
    cmd = f'. "{repo_root}/agentic-development/lib/cost-tracker.sh"; export_session_json "{sid}" "{tmp.name}"'
    subprocess.check_call(["bash", "-lc", cmd], cwd=repo_root)
    with open(tmp.name, "r") as f:
        data = json.load(f)
    os.unlink(tmp.name)
    return data

def bash_json(cmd):
    return json.loads(subprocess.check_output(["bash", "-lc", cmd], cwd=repo_root, text=True))

if not session_id:
    sessions = json.loads(subprocess.check_output(["bash", "-lc", "opencode session list --format json -n 20"], cwd=repo_root, text=True))
    chosen = None
    for session in sessions:
        try:
            data = export_json(session["id"])
        except Exception:
            continue
        has_tasks = False
        for message in data.get("messages", []):
            for part in message.get("parts", []):
                if part.get("type") == "tool" and part.get("tool") == "task":
                    has_tasks = True
                    break
            if has_tasks:
                break
        if has_tasks:
            chosen = session["id"]
            root_export = data
            break
    if chosen is None:
        print("**Workflow:** Ultraworks")
        print("")
        print("## Telemetry")
        print("")
        print("_No workflow telemetry found._")
        sys.exit(0)
else:
    chosen = session_id
    root_export = export_json(chosen)

agent_rows = []
seen = set()
for message in root_export.get("messages", []):
    for part in message.get("parts", []):
        if part.get("type") != "tool" or part.get("tool") != "task":
            continue
        state = part.get("state", {}) or {}
        metadata = state.get("metadata", {}) or {}
        child_session = metadata.get("sessionId")
        subagent = (state.get("input", {}) or {}).get("subagent_type", "")
        if not child_session or child_session in seen:
            continue
        seen.add(child_session)
        try:
            child_data = export_json(child_session)
        except Exception:
            continue
        child_tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".json")
        child_tmp.close()
        with open(child_tmp.name, "w") as f:
            json.dump(child_data, f)
        tokens = bash_json(f'. "{repo_root}/agentic-development/lib/cost-tracker.sh"; summarize_export_tokens "{child_tmp.name}"')
        tools = bash_json(f'. "{repo_root}/agentic-development/lib/cost-tracker.sh"; extract_session_tools "{child_tmp.name}"')
        files_read = bash_json(f'. "{repo_root}/agentic-development/lib/cost-tracker.sh"; extract_session_files_read "{child_tmp.name}"')
        context = bash_json(f'. "{repo_root}/agentic-development/lib/cost-tracker.sh"; extract_session_context "{child_tmp.name}"')
        model = subprocess.check_output(["bash", "-lc", f'. "{repo_root}/agentic-development/lib/cost-tracker.sh"; extract_export_model "{child_tmp.name}"'], cwd=repo_root, text=True).strip()
        cost = float(subprocess.check_output(["bash", "-lc", f'. "{repo_root}/agentic-development/lib/cost-tracker.sh"; calculate_cost_from_values "{model}" "{tokens.get("input_tokens",0)}" "{tokens.get("output_tokens",0)}" "{tokens.get("cache_read",0)}"'], cwd=repo_root, text=True).strip())
        info = child_data.get("info", {}).get("time", {})
        duration_seconds = max(0, int((info.get("updated", 0) - info.get("created", 0)) / 1000))
        os.unlink(child_tmp.name)
        agent_rows.append({
            "agent": subagent.replace("s-", ""),
            "model": model,
            "tokens": tokens,
            "tools": tools,
            "files_read": files_read,
            "context": context,
            "cost": cost,
            "duration_seconds": duration_seconds,
        })

if not agent_rows:
    root_tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".json")
    root_tmp.close()
    with open(root_tmp.name, "w") as f:
        json.dump(root_export, f)
    tokens = bash_json(f'. "{repo_root}/agentic-development/lib/cost-tracker.sh"; summarize_export_tokens "{root_tmp.name}"')
    tools = bash_json(f'. "{repo_root}/agentic-development/lib/cost-tracker.sh"; extract_session_tools "{root_tmp.name}"')
    files_read = bash_json(f'. "{repo_root}/agentic-development/lib/cost-tracker.sh"; extract_session_files_read "{root_tmp.name}"')
    context = bash_json(f'. "{repo_root}/agentic-development/lib/cost-tracker.sh"; extract_session_context "{root_tmp.name}"')
    model = subprocess.check_output(["bash", "-lc", f'. "{repo_root}/agentic-development/lib/cost-tracker.sh"; extract_export_model "{root_tmp.name}"'], cwd=repo_root, text=True).strip()
    cost = float(subprocess.check_output(["bash", "-lc", f'. "{repo_root}/agentic-development/lib/cost-tracker.sh"; calculate_cost_from_values "{model}" "{tokens.get("input_tokens",0)}" "{tokens.get("output_tokens",0)}" "{tokens.get("cache_read",0)}"'], cwd=repo_root, text=True).strip())
    info = root_export.get("info", {}).get("time", {})
    duration_seconds = max(0, int((info.get("updated", 0) - info.get("created", 0)) / 1000))
    os.unlink(root_tmp.name)
    agent_rows.append({
        "agent": "sisyphus",
        "model": model,
        "tokens": tokens,
        "tools": tools,
        "files_read": files_read,
        "context": context,
        "cost": cost,
        "duration_seconds": duration_seconds,
    })

def money(val):
    return f"${val:.4f}"

def dur(seconds):
    seconds = int(seconds)
    if seconds >= 60:
        return f"{seconds // 60}m {seconds % 60:02d}s"
    return f"{seconds}s"

print("**Workflow:** Ultraworks")
print("")
print("## Telemetry")
print("")
print("| Agent | Model | Input | Output | Price | Time |")
print("|-------|-------|------:|-------:|------:|-----:|")
for row in agent_rows:
    print(f"| {row['agent']} | {row['model']} | {row['tokens'].get('input_tokens',0)} | {row['tokens'].get('output_tokens',0)} | {money(row['cost'])} | {dur(row['duration_seconds'])} |")

model_totals = {}
for row in agent_rows:
    item = model_totals.setdefault(row["model"], {"agents": [], "input": 0, "output": 0, "price": 0.0})
    item["agents"].append(row["agent"])
    item["input"] += int(row["tokens"].get("input_tokens", 0))
    item["output"] += int(row["tokens"].get("output_tokens", 0))
    item["price"] += row["cost"]

print("")
print("## Моделі")
print("")
print("| Model | Agents | Input | Output | Price |")
print("|-------|--------|------:|-------:|------:|")
for model, item in sorted(model_totals.items()):
    print(f"| {model} | {', '.join(item['agents'])} | {item['input']} | {item['output']} | {money(item['price'])} |")

print("")
print("## Tools By Agent")
print("")
for row in agent_rows:
    print(f"### {row['agent']}")
    if row["tools"]:
        for tool in row["tools"]:
            print(f"- `{tool.get('name','unknown')}` x {tool.get('count', 0)}")
    else:
        print("- none recorded")
    print("")

print("## Context Modifiers By Agent")
print("")
print("_Skills, MCP tools, and commands that influenced LLM behavior._")
print("")
has_context = False
for row in agent_rows:
    ctx = row.get("context", {})
    skills = ctx.get("skills", [])
    mcp = ctx.get("mcp_tools", [])
    cmds = ctx.get("claude_commands", [])
    if skills or mcp or cmds:
        has_context = True
        print(f"### {row['agent']}")
        if skills:
            for s in skills:
                print(f"- **Skill:** `{s.get('name', '?')}`")
        if mcp:
            for m in mcp:
                print(f"- **MCP:** `{m.get('name', '?')}` x{m.get('count', 0)}")
        if cmds:
            for c in cmds:
                print(f"- **Command:** `/{c}`")
        print("")
if not has_context:
    print("_No context modifiers detected (no skills, MCP tools, or commands used)._")
    print("")

print("## Files Read By Agent")
print("")
for row in agent_rows:
    print(f"### {row['agent']}")
    if row["files_read"]:
        for file_path in row["files_read"]:
            print(f"- `{file_path}`")
    else:
        print("- none recorded")
    print("")
PYEOF
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
