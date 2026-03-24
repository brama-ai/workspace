#!/usr/bin/env python3
import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(os.environ.get("PIPELINE_REPO_ROOT", Path(__file__).resolve().parents[2]))
TASKS_ROOT = REPO_ROOT / "tasks"
LEGACY_SUMMARY_DIR = REPO_ROOT / "agentic-development" / "foundry-tasks" / "summary"
DEFAULT_HANDOFF = REPO_ROOT / ".opencode" / "pipeline" / "handoff.md"


def run(cmd: list[str]) -> str:
    return subprocess.check_output(cmd, cwd=REPO_ROOT, text=True)


def latest_summary(since_epoch: int | None, workflow: str) -> Path | None:
    files: list[Path] = []
    if workflow == "ultraworks":
        files = [p for p in TASKS_ROOT.glob("*--ultraworks/summary.md") if p.is_file()]
    else:
        files = [p for p in TASKS_ROOT.glob("*--foundry/summary.md") if p.is_file()]
        if not files and LEGACY_SUMMARY_DIR.exists():
            files = [p for p in LEGACY_SUMMARY_DIR.glob("*.md") if p.name != ".gitkeep"]
    if since_epoch is not None:
        files = [p for p in files if int(p.stat().st_mtime) >= since_epoch]
    if not files:
        return None
    return max(files, key=lambda p: p.stat().st_mtime)


def pick_session(session_id: str | None, since_epoch: int | None) -> dict | None:
    try:
        raw = run(["opencode", "session", "list", "--format", "json", "-n", "50"])
        sessions = json.loads(raw)
    except (subprocess.CalledProcessError, FileNotFoundError, json.JSONDecodeError):
        return None
    if session_id:
        for session in sessions:
            if session["id"] == session_id:
                return session
        return None
    candidates = [s for s in sessions if s.get("directory", "").startswith(str(REPO_ROOT))]
    if since_epoch is not None:
        since_ms = since_epoch * 1000
        candidates = [s for s in candidates if s.get("created", 0) >= since_ms or s.get("updated", 0) >= since_ms]
    candidates = [s for s in candidates if s.get("title") != "Greeting"]
    if not candidates:
        return None
    return max(candidates, key=lambda s: s.get("updated", 0))


def human_duration(seconds: int) -> str:
    if seconds >= 60:
        return f"{seconds // 60}m {seconds % 60:02d}s"
    return f"{seconds}s"


def clean_md(text: str) -> str:
    text = re.sub(r"`([^`]+)`", r"\1", text)
    text = re.sub(r"\*\*([^*]+)\*\*", r"\1", text)
    return text.strip(" -")


def extract_section(text: str, header: str) -> str:
    pattern = rf"^## {re.escape(header)}\s*$([\s\S]*?)(?=^## |\Z)"
    match = re.search(pattern, text, re.MULTILINE)
    return match.group(1).strip() if match else ""


def extract_title(text: str) -> str:
    match = re.search(r"^#\s+(.+)$", text, re.MULTILINE)
    return clean_md(match.group(1)) if match else "Pipeline Summary"


def slugify(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def extract_status(text: str) -> str:
    lowered = text.lower()
    if "pipeline incomplete" in lowered or "**статус:** fail" in lowered or "**status:** fail" in lowered:
        return "FAIL"
    return "PASS"


def extract_bullets_from_summary(text: str) -> list[str]:
    bullets: list[str] = []
    summary_section = extract_section(text, "Summary") or extract_section(text, "Що зроблено")
    for line in summary_section.splitlines():
        if line.strip().startswith("- "):
            bullets.append(clean_md(line))

    files_section = extract_section(text, "Files Changed")
    for line in files_section.splitlines():
        if line.strip().startswith("|") and "File" not in line and "---" not in line:
            parts = [p.strip() for p in line.strip("|").split("|")]
            if len(parts) >= 3:
                bullets.append(f"{parts[1].capitalize()} {parts[0]} — {parts[2]}")

    seen = set()
    result = []
    for bullet in bullets:
      if bullet and bullet not in seen:
        seen.add(bullet)
        result.append(bullet)
    return result


def parse_handoff_sections(text: str) -> dict[str, dict]:
    sections: dict[str, dict] = {}
    current = None
    for raw_line in text.splitlines():
        line = raw_line.rstrip()
        match = re.match(r"^##\s+(.+)$", line)
        if match:
            current = match.group(1).strip()
            sections[current] = {"lines": []}
            continue
        if current:
            sections[current]["lines"].append(line)

    for name, section in sections.items():
        status = ""
        for line in section["lines"]:
            m = re.match(r"- \*\*Status\*\*: (.+)", line)
            if m:
                status = m.group(1).strip()
                break
        section["status"] = status
    return sections


def bullets_from_handoff(sections: dict[str, dict]) -> list[str]:
    items = []
    for name, section in sections.items():
        if name.lower() in {"task description", "summarizer"}:
            continue
        status = section.get("status", "").lower()
        if status not in {"done", "completed"}:
            continue
        for line in section["lines"]:
            if any(token in line for token in ("**Result**:", "**Completed**:", "**Files changed**:", "**Files Changed**:", "**Verification**:")):
                items.append(f"{name}: {clean_md(line)}")
    return items


def difficulties_from_texts(texts: list[str]) -> list[str]:
    items = []
    for text in texts:
        for line in text.splitlines():
            lowered = line.lower()
            if any(token in lowered for token in ("not installed", "error", "fail", "warning", "warn", "skipped", "flaky")):
                items.append(clean_md(line))
    deduped = []
    seen = set()
    for item in items:
        if item and item not in seen:
            seen.add(item)
            deduped.append(item)
    return deduped[:4]


def unfinished_from_handoff(sections: dict[str, dict]) -> list[str]:
    items = []
    for name, section in sections.items():
        status = section.get("status", "").lower()
        if status in {"pending", "in_progress", "in progress"}:
            items.append(f"{name}: статус {section['status']}")
    return items


def next_task_from_existing(text: str) -> str:
    next_section = extract_section(text, "Next Steps") or extract_section(text, "Наступна задача")
    for line in next_section.splitlines():
        stripped = line.strip()
        if stripped.startswith(("1.", "2.", "- ")):
            return re.sub(r"^[0-9]+\.\s*", "", clean_md(stripped))
    return "Архівувати завершений change або запустити наступну незавершену OpenSpec задачу."


def profile_from_handoff(text: str) -> str:
    match = re.search(r"- \*\*Profile\*\*: (.+)", text)
    return clean_md(match.group(1)) if match else "—"


def task_name_from_handoff(text: str) -> str:
    match = re.search(r"- \*\*Task\*\*: (.+)", text)
    return clean_md(match.group(1)) if match else ""


def telemetry_block(workflow: str, task_slug: str, session_id: str | None) -> str:
    tracker_workflow = "builder" if workflow in {"builder", "foundry"} else workflow
    cmd = [str(REPO_ROOT / "agentic-development" / "lib" / "cost-tracker.sh"), "summary-block", "--workflow", tracker_workflow]
    if tracker_workflow == "builder":
        cmd.extend(["--task-slug", task_slug])
    elif session_id:
        cmd.extend(["--session-id", session_id])
    text = run(cmd).strip()
    lines = text.splitlines()
    if lines and lines[0].startswith("**Workflow:**"):
        lines = lines[1:]
        if lines and not lines[0].strip():
            lines = lines[1:]
    return "\n".join(lines).strip()


def render(args) -> str:
    summary_path = Path(args.summary_file) if args.summary_file else latest_summary(args.since_epoch, args.workflow)
    if summary_path is None or not summary_path.exists():
        raise SystemExit("No summary file found to normalize.")

    original = summary_path.read_text()
    handoff_text = ""
    handoff_path = Path(args.handoff_file) if args.handoff_file else DEFAULT_HANDOFF
    if handoff_path.exists():
        handoff_text = handoff_path.read_text()

    title = extract_title(original)
    if handoff_text:
        handoff_task_name = task_name_from_handoff(handoff_text)
        if handoff_task_name and title.lower() in {"unknown", "pipeline summary", "pipeline summary: unknown"}:
            title = handoff_task_name
    if handoff_text:
        task_match = re.search(r"- \*\*Task\*\*: (.+)", handoff_text)
        if task_match:
            handoff_task = clean_md(task_match.group(1))
            title_slug = slugify(title)
            handoff_slug = slugify(handoff_task)
            if title_slug and handoff_slug and title_slug not in handoff_slug and handoff_slug not in title_slug:
                handoff_text = ""
    status = extract_status(original)
    session = pick_session(args.session_id, args.since_epoch)
    session_id = session["id"] if session else None
    duration = "—"
    if session:
        duration = human_duration(max(0, int((session["updated"] - session["created"]) / 1000)))

    profile = profile_from_handoff(handoff_text)
    sections = parse_handoff_sections(handoff_text) if handoff_text else {}

    done_items = extract_bullets_from_summary(original)
    if not done_items:
        done_items = bullets_from_handoff(sections)
    if not done_items:
        done_items = ["Результати зафіксовані в summary, але деталізовані bullet points не були знайдені."]

    difficulties = difficulties_from_texts([original, handoff_text])
    if not difficulties:
        difficulties = ["Суттєвих блокерів під час цього запуску не зафіксовано."]

    unfinished = unfinished_from_handoff(sections)
    if not unfinished and status == "PASS":
        unfinished = ["Немає незавершених пунктів у межах цього запуску."]
    elif not unfinished:
        unfinished = ["Є незавершені роботи; див. handoff та telemetry для деталей."]

    next_task = next_task_from_existing(original)
    task_slug = args.task_slug or summary_path.stem
    telemetry = telemetry_block(args.workflow, task_slug, session_id)

    lines = [
        f"# {title}",
        "",
        f"**Статус:** {status}",
        f"**Workflow:** {'Foundry' if args.workflow == 'foundry' else 'Ultraworks'}",
        f"**Профіль:** {profile}",
        f"**Тривалість:** {duration}",
        "",
        "## Що зроблено",
    ]
    lines.extend(f"- {item}" for item in done_items)
    lines.extend(["", telemetry, "", "## Труднощі"])
    lines.extend(f"- {item}" for item in difficulties)
    lines.extend(["", "## Незавершене"])
    lines.extend(f"- {item}" for item in unfinished)
    lines.extend(["", "## Наступна задача", next_task.strip()])
    return "\n".join(lines).rstrip() + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workflow", choices=["builder", "foundry", "ultraworks"], required=True)
    parser.add_argument("--summary-file")
    parser.add_argument("--session-id")
    parser.add_argument("--handoff-file")
    parser.add_argument("--task-slug")
    parser.add_argument("--since-epoch", type=int)
    args = parser.parse_args()

    summary_path = Path(args.summary_file) if args.summary_file else latest_summary(args.since_epoch, args.workflow)
    if summary_path is None:
        print("No summary file found.", file=sys.stderr)
        return 1

    normalized = render(args)
    summary_path.write_text(normalized)
    print(summary_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
