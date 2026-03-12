#!/usr/bin/env python3
"""Run-scoped team scratchpad helper for coding team agents.

Data root: .tmp/team-runs/<run_id>/
- meta.json
- scratchpad.jsonl
- scratchpad.md (generated)
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from collections import OrderedDict, defaultdict
from datetime import datetime, timezone
from pathlib import Path

try:
    import fcntl
except ImportError as exc:  # pragma: no cover
    raise SystemExit(f"Error: file locking requires fcntl support: {exc}")


VALID_STATUS = {
    "start",
    "in_progress",
    "blocked",
    "red",
    "green",
    "review",
    "done",
}


def now_utc_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


def runs_root() -> Path:
    return repo_root() / ".tmp" / "team-runs"


def validate_run_id(run_id: str) -> str:
    value = (run_id or "").strip()
    if not value:
        raise ValueError("run id cannot be empty")
    if "/" in value or "\\" in value or value in {".", ".."}:
        raise ValueError("run id must be a simple name (no path separators)")
    return value


def parse_csv_list(value: str | None) -> list[str]:
    if value is None:
        return []
    raw = value.strip()
    if not raw:
        return []
    return [item.strip() for item in next(csv.reader([raw])) if item.strip()]


def run_dir(run_id: str) -> Path:
    return runs_root() / run_id


def meta_path(run_id: str) -> Path:
    return run_dir(run_id) / "meta.json"


def log_path(run_id: str) -> Path:
    return run_dir(run_id) / "scratchpad.jsonl"


def md_path(run_id: str) -> Path:
    return run_dir(run_id) / "scratchpad.md"


def ensure_run_exists(run_id: str) -> None:
    mpath = meta_path(run_id)
    lpath = log_path(run_id)
    if not mpath.exists() or not lpath.exists():
        raise FileNotFoundError(
            f"run '{run_id}' not found; expected {mpath} and {lpath}. Initialize with 'init' first."
        )


def read_meta(run_id: str) -> dict:
    ensure_run_exists(run_id)
    with meta_path(run_id).open("r", encoding="utf-8") as fh:
        return json.load(fh)


def read_entries(run_id: str) -> list[dict]:
    ensure_run_exists(run_id)
    entries: list[dict] = []
    with log_path(run_id).open("r", encoding="utf-8") as fh:
        for idx, line in enumerate(fh, start=1):
            text = line.strip()
            if not text:
                continue
            try:
                item = json.loads(text)
            except json.JSONDecodeError as exc:
                raise ValueError(
                    f"invalid JSONL in {log_path(run_id)} line {idx}: {exc.msg}"
                ) from exc
            if isinstance(item, dict):
                entries.append(item)
    return entries


def write_entry(run_id: str, entry: dict) -> None:
    lpath = log_path(run_id)
    with lpath.open("a", encoding="utf-8") as fh:
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
        try:
            fh.write(json.dumps(entry, ensure_ascii=True) + "\n")
            fh.flush()
            os.fsync(fh.fileno())
        finally:
            fcntl.flock(fh.fileno(), fcntl.LOCK_UN)


def format_entry_line(entry: dict) -> str:
    files = entry.get("files") or []
    blockers = entry.get("blockers") or []
    files_text = f" files={', '.join(files)}" if files else ""
    blockers_text = f" blockers={', '.join(blockers)}" if blockers else ""
    next_text = f" next={entry.get('next', '')}" if entry.get("next") else ""
    return (
        f"[{entry.get('ts', '?')}] {entry.get('agent', '?')} "
        f"phase={entry.get('phase', '?')} status={entry.get('status', '?')} "
        f"{entry.get('summary', '')}{files_text}{blockers_text}{next_text}"
    )


def latest_by_agent(entries: list[dict]) -> OrderedDict[str, dict]:
    latest: OrderedDict[str, dict] = OrderedDict()
    for entry in entries:
        agent = str(entry.get("agent", "")).strip() or "unknown"
        latest[agent] = entry
    return latest


def summarize_blockers(latest: OrderedDict[str, dict]) -> dict[str, list[str]]:
    blockers: dict[str, list[str]] = defaultdict(list)
    for agent, entry in latest.items():
        for blocker in entry.get("blockers") or []:
            if blocker not in blockers:
                blockers[blocker] = []
            blockers[blocker].append(agent)
    return dict(blockers)


def cmd_init(args: argparse.Namespace) -> int:
    run_id = validate_run_id(args.run_id)
    task = args.task.strip()
    if not task:
        raise ValueError("task cannot be empty")

    rdir = run_dir(run_id)
    if rdir.exists():
        raise FileExistsError(f"run '{run_id}' already exists at {rdir}")

    rdir.mkdir(parents=True, exist_ok=False)
    lpath = log_path(run_id)
    lpath.touch(exist_ok=False)

    meta = {
        "run_id": run_id,
        "task": task,
        "base_branch": args.base_branch.strip() if args.base_branch else None,
        "repo": str(Path(args.repo).resolve() if args.repo else repo_root().resolve()),
        "created_at": now_utc_iso(),
    }
    with meta_path(run_id).open("w", encoding="utf-8") as fh:
        json.dump(meta, fh, indent=2)
        fh.write("\n")

    print(f"Initialized run '{run_id}' at {rdir}")
    print(f"- meta: {meta_path(run_id)}")
    print(f"- log:  {lpath}")
    return 0


def cmd_post(args: argparse.Namespace) -> int:
    run_id = validate_run_id(args.run_id)
    ensure_run_exists(run_id)

    status = args.status.strip()
    if status not in VALID_STATUS:
        raise ValueError(f"invalid status '{status}'; expected one of: {', '.join(sorted(VALID_STATUS))}")

    agent = args.agent.strip()
    phase = args.phase.strip()
    summary = args.summary.strip()
    if not agent:
        raise ValueError("agent cannot be empty")
    if not phase:
        raise ValueError("phase cannot be empty")
    if not summary:
        raise ValueError("summary cannot be empty")

    entry = {
        "ts": now_utc_iso(),
        "run_id": run_id,
        "agent": agent,
        "phase": phase,
        "status": status,
        "summary": summary,
        "files": parse_csv_list(args.files),
        "blockers": parse_csv_list(args.blockers),
        "next": args.next.strip() if args.next else "",
    }

    write_entry(run_id, entry)
    print(f"Posted update for run '{run_id}' agent '{agent}'")
    return 0


def cmd_tail(args: argparse.Namespace) -> int:
    run_id = validate_run_id(args.run_id)
    entries = read_entries(run_id)

    lines = args.lines
    if lines <= 0:
        raise ValueError("--lines must be a positive integer")

    for entry in entries[-lines:]:
        print(format_entry_line(entry))
    if not entries:
        print(f"No entries yet for run '{run_id}'.")
    return 0


def cmd_summary(args: argparse.Namespace) -> int:
    run_id = validate_run_id(args.run_id)
    meta = read_meta(run_id)
    entries = read_entries(run_id)

    print(f"Run: {run_id}")
    print(f"Task: {meta.get('task', '')}")
    if not entries:
        print("No entries yet.")
        return 0

    latest = latest_by_agent(entries)
    print("\nLatest per agent:")
    for agent, entry in latest.items():
        print(
            f"- {agent}: status={entry.get('status')} phase={entry.get('phase')} summary={entry.get('summary')}"
        )

    print("\nLast updated per agent:")
    for agent, entry in latest.items():
        print(f"- {agent}: {entry.get('ts')}")

    blockers = summarize_blockers(latest)
    print("\nActive blockers:")
    if blockers:
        for blocker, agents in sorted(blockers.items()):
            print(f"- {blocker} (agents: {', '.join(agents)})")
    else:
        print("- none")

    return 0


def build_markdown(run_id: str, meta: dict, entries: list[dict]) -> str:
    lines: list[str] = []
    lines.append(f"# Team Scratchpad: {run_id}")
    lines.append("")
    lines.append("## Run metadata")
    lines.append("")
    lines.append(f"- Run ID: `{run_id}`")
    lines.append(f"- Task: {meta.get('task', '')}")
    lines.append(f"- Base branch: {meta.get('base_branch') or '(not set)'}")
    lines.append(f"- Repo: `{meta.get('repo', '')}`")
    lines.append(f"- Created: {meta.get('created_at', '')}")
    lines.append("")

    latest = latest_by_agent(entries)
    lines.append("## Latest per agent")
    lines.append("")
    if latest:
        for agent, entry in latest.items():
            lines.append(
                f"- **{agent}**: `{entry.get('status')}` in `{entry.get('phase')}` "
                f"({entry.get('ts')}) - {entry.get('summary')}"
            )
    else:
        lines.append("- No updates yet.")
    lines.append("")

    blockers = summarize_blockers(latest)
    lines.append("## Blockers")
    lines.append("")
    if blockers:
        for blocker, agents in sorted(blockers.items()):
            lines.append(f"- {blocker} (agents: {', '.join(agents)})")
    else:
        lines.append("- none")
    lines.append("")

    lines.append("## Recent updates (last 20)")
    lines.append("")
    recent = entries[-20:]
    if recent:
        for entry in recent:
            files = entry.get("files") or []
            blockers_for_entry = entry.get("blockers") or []
            lines.append(
                f"- {entry.get('ts')} **{entry.get('agent')}** "
                f"`{entry.get('status')}` `{entry.get('phase')}`: {entry.get('summary')}"
            )
            if files:
                lines.append(f"  - files: {', '.join(files)}")
            if blockers_for_entry:
                lines.append(f"  - blockers: {', '.join(blockers_for_entry)}")
            if entry.get("next"):
                lines.append(f"  - next: {entry.get('next')}")
    else:
        lines.append("- No updates yet.")

    lines.append("")
    return "\n".join(lines)


def cmd_render_md(args: argparse.Namespace) -> int:
    run_id = validate_run_id(args.run_id)
    meta = read_meta(run_id)
    entries = read_entries(run_id)

    markdown = build_markdown(run_id, meta, entries)
    target = md_path(run_id)
    with target.open("w", encoding="utf-8") as fh:
        fh.write(markdown)

    print(f"Wrote markdown dashboard: {target}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run-scoped team scratchpad helper")
    sub = parser.add_subparsers(dest="command", required=True)

    p_init = sub.add_parser("init", help="Initialize a scratchpad run")
    p_init.add_argument("--run-id", required=True, help="Run identifier")
    p_init.add_argument("--task", required=True, help="Top-level task description")
    p_init.add_argument("--base-branch", help="Base git branch")
    p_init.add_argument("--repo", help="Repository path")
    p_init.set_defaults(func=cmd_init)

    p_post = sub.add_parser("post", help="Append an agent update")
    p_post.add_argument("--run-id", required=True, help="Run identifier")
    p_post.add_argument("--agent", required=True, help="Agent name")
    p_post.add_argument("--phase", required=True, help="Phase name")
    p_post.add_argument("--status", required=True, help=f"Status ({', '.join(sorted(VALID_STATUS))})")
    p_post.add_argument("--summary", required=True, help="Update summary")
    p_post.add_argument("--files", help="CSV of touched files")
    p_post.add_argument("--blockers", help="CSV of blockers")
    p_post.add_argument("--next", help="Next action")
    p_post.set_defaults(func=cmd_post)

    p_tail = sub.add_parser("tail", help="Show recent updates")
    p_tail.add_argument("--run-id", required=True, help="Run identifier")
    p_tail.add_argument("--lines", type=int, default=20, help="Number of updates to show")
    p_tail.set_defaults(func=cmd_tail)

    p_summary = sub.add_parser("summary", help="Show latest per-agent status and blockers")
    p_summary.add_argument("--run-id", required=True, help="Run identifier")
    p_summary.set_defaults(func=cmd_summary)

    p_render = sub.add_parser("render-md", help="Render markdown dashboard")
    p_render.add_argument("--run-id", required=True, help="Run identifier")
    p_render.set_defaults(func=cmd_render_md)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.func(args))
    except (FileNotFoundError, FileExistsError, ValueError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
