#!/usr/bin/env bash
# Post-mortem summary generator
# Runs after opencode pipeline finishes. If no summary was created by summarizer,
# generates a basic one from handoff.md state.
#
# Usage: internal helper invoked by ./agentic-development/ultraworks.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${PIPELINE_REPO_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/foundry-common.sh"
HANDOFF="$PROJECT_ROOT/.opencode/pipeline/handoff.md"
SUMMARY_FILE=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --handoff)
            HANDOFF="$2"
            shift 2
            ;;
        --summary-file)
            SUMMARY_FILE="$2"
            shift 2
            ;;
        *)
            HANDOFF="$1"
            shift
            ;;
    esac
done

if [[ ! -f "$HANDOFF" ]]; then
    echo "No handoff.md found, skipping post-mortem."
    exit 0
fi

# Extract metadata from handoff (handles both **bold** and plain markdown)
PIPELINE_ID=$(grep -m1 'Pipeline ID' "$HANDOFF" | sed 's/.*: *//' | tr -d '`*' | xargs 2>/dev/null || echo "unknown")
TASK_NAME=$(grep -m1 'Task' "$HANDOFF" | head -1 | sed 's/.*Task[^:]*: *//' | tr -d '*' | head -c 100 || echo "unknown")
TIMESTAMP=$(date +%Y%m%d)

# Sanitize for filename
SLUG=$(pipeline_slugify "$PIPELINE_ID")
if [[ -z "$SLUG" || "$SLUG" == "unknown" ]]; then
  SLUG=$(pipeline_slugify "$TASK_NAME")
fi
SLUG="${SLUG:0:50}"
if [[ -z "$SUMMARY_FILE" ]]; then
    ensure_pipeline_tasks_root
    SUMMARY_DIR="$PIPELINE_TASKS_ROOT/${SLUG}--ultraworks"
    SUMMARY_FILE="$SUMMARY_DIR/summary.md"
else
    SUMMARY_DIR="$(dirname "$SUMMARY_FILE")"
fi

# Check if summary already exists
if [[ -s "$SUMMARY_FILE" ]]; then
    echo "Summary already exists for $SLUG"
    exit 0
fi

mkdir -p "$SUMMARY_DIR"

echo "Generating post-mortem summary from handoff..."

# Build phase table by parsing handoff sections
PHASES=""
for phase in Architect Coder Reviewer Validator Tester E2E Auditor Documenter Summarizer; do
    # Extract section between "## Phase" and next "---"
    section=$(awk "/^## ${phase}$/,/^---$/" "$HANDOFF" 2>/dev/null || true)
    if [[ -z "$section" ]]; then
        continue
    fi

    # Get status
    phase_status=$(echo "$section" | grep -m1 'Status' | sed 's/.*: *//' | tr -d '`*' | xargs || echo "unknown")

    # Map to icon
    case "$phase_status" in
        done|completed)    icon="done" ;;
        failed|error)      icon="FAIL" ;;
        timeout)           icon="TIMEOUT" ;;
        pending)           icon="SKIPPED" ;;
        in_progress)       icon="INTERRUPTED" ;;
        skipped)           icon="skipped" ;;
        initialized)       icon="skipped" ;;
        *)                 icon="$phase_status" ;;
    esac

    # Get result summary (first meaningful line after Status)
    result=$(echo "$section" | grep -m1 'Result\|Summary\|Task\|Verdict' | sed 's/.*: *//' | head -c 120 || echo "")

    PHASES="${PHASES}| ${phase} | ${icon} | ${result} |\n"
done

cat > "$SUMMARY_FILE" << SUMMARY
# Pipeline Summary: ${PIPELINE_ID}

> **Auto-generated post-mortem** — summarizer did not complete. Generated from handoff.md state.

**Workflow:** Ultraworks
**Status:** FAIL

## Task

${TASK_NAME}

## Phase Results

| Phase | Status | Details |
|-------|--------|---------|
$(echo -e "$PHASES")

## Рекомендації по оптимізації

### 🔴 Pipeline incomplete: summarizer не завершився
**Що сталось:** Pipeline обірвався до фази summarizer — можливо ліміт токенів, таймаут або фейл субагента.
**Вплив:** Summary не згенеровано автоматично, ручний post-mortem.
**Рекомендація:**
- Перевірити лог: \`./agentic-development/monitor/ultraworks-monitor.sh logs\`
- Якщо субагент підвис: перевірити модель (fast model для validator), додати timeout в Sisyphus
- Якщо ліміт токенів: зменшити scope задачі або розбити на підзадачі
- Відновити: \`/finish\` в OpenCode або перезапустити через ultraworks-monitor.sh

## Verdict

Pipeline did not complete normally. Review handoff.md for details:
\`cat ${HANDOFF#"$PROJECT_ROOT"/}\`

To resume: run \`/finish\` in OpenCode or relaunch with \`ultraworks-monitor.sh launch\`.

---
*Generated: $(date -Iseconds)*
SUMMARY

echo "Post-mortem summary: $SUMMARY_FILE"
