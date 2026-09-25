#!/usr/bin/env python3
"""Installer entrypoint and fast, offline Claude Code hooks."""

import sys

if sys.version_info < (3, 9):
    print("XPowers Claude routing requires Python 3.9 or newer.", file=sys.stderr)
    raise SystemExit(1)

sys.dont_write_bytecode = True

import argparse
import json
import os
from pathlib import Path

import common


def check_profile(project, config):
    """Check native files too: a snapshot alone cannot prove routing is installed."""
    import install
    common.check_generated(project, config)
    for role in install.ROLES:
        target = project / ".claude" / "agents" / f"xpowers-routing-{role}.md"
        if target.read_bytes() != install._agent(role, config):
            raise ValueError(f"Generated {role} agent changed; resolve local edits and rerun setup-claude-routing.sh")
    settings = json.loads((project / ".claude/settings.json").read_text())
    if not isinstance(settings, dict) or settings.get("disableAllHooks"):
        raise ValueError("Routing hooks are disabled in project settings")
    if not isinstance(settings.get("hooks"), dict):
        raise ValueError("Routing hooks are missing from project settings")
    config_dir = common.claude_config_dir()
    for extra in (project / ".claude/settings.local.json", config_dir / "settings.json"):
        if extra.exists():
            value = json.loads(extra.read_text())
            if not isinstance(value, dict):
                raise ValueError(f"Invalid Claude settings object: {extra}")
            if value.get("disableAllHooks"):
                raise ValueError(f"Routing hooks are disabled in {extra}")
    for event, entry in install._hook_entries(project).items():
        if entry not in settings.get("hooks", {}).get(event, []):
            raise ValueError(f"Missing routing {event} hook; rerun setup-claude-routing.sh")
    control = common.control_dir(project)
    install._safe_target(control / "install-manifest.json", Path.home())
    manifest = install._read_manifest(control, project)
    if manifest is None:
        raise ValueError("Routing ownership backup is missing; recover the external install-manifest.json before activation")
    files = manifest.get("files")
    if not isinstance(files, dict):
        raise ValueError("Routing ownership manifest is missing file snapshots; recover the installation backup")
    runtime_files = {name: snapshots.get("installed") if isinstance(snapshots, dict) else None for name, snapshots in files.items()
                     if name.startswith("xpowers-routing/") and name.endswith(".py")}
    for filename in ("cli.py", "common.py", "guard.py", "install.py"):
        if not isinstance(runtime_files.get("xpowers-routing/" + filename), dict):
            raise ValueError(f"Routing ownership snapshot is missing for {filename}; recover the installation backup")
    for name, snapshot in runtime_files.items():
        if not isinstance(snapshot, dict):
            raise ValueError(f"Routing ownership snapshot is missing for {name}; recover the installation backup")
        target = project / ".claude" / name
        install._safe_target(target, project)
        if install._snapshot(target) != snapshot:
            raise ValueError(f"Installed routing runtime changed or is missing: {target.name}; resolve local edits and rerun setup-claude-routing.sh")
    runtime_dir = project / ".claude/xpowers-routing"
    unexpected = {str(target.relative_to(project / ".claude")) for target in runtime_dir.rglob("*.py")} - set(runtime_files)
    if unexpected:
        raise ValueError("Installed routing runtime changed: unowned Python files: " + ", ".join(sorted(unexpected)))


def active(project, session):
    state = common.session_path(project, session)
    if not state.exists():
        return False
    data = json.loads(state.read_text())
    if not isinstance(data, dict) or type(data.get("enabled")) is not bool:
        raise ValueError("Invalid routing session state; run /routing-off to reset it")
    return data["enabled"]


def smoke(project, session):
    config = common.load_config(project)
    check_profile(project, config)
    import guard
    if not active(project, session):
        raise ValueError("Run /routing-on in this session before /routing-smoke-test")
    base = {"session_id": session, "cwd": str(project)}
    cases = [
        ("coordinator source edit denied", {"tool_name": "Write", "tool_input": {"file_path": str(project / ".routing-smoke-never-written"), "content": "never executed"}}, True),
        ("external scratch allowed", {"tool_name": "Write", "tool_input": {"file_path": str(common.control_dir(project).parent.parent / "routing-smoke-never-written.md")}}, False),
        ("main --agent cannot bypass guard", {"agent_type": "xpowers-routing-worker", "tool_name": "Edit", "tool_input": {"file_path": str(project / "file.txt")}}, True),
        ("delegated worker can edit", {"agent_id": "smoke-worker", "agent_type": "xpowers-routing-worker", "tool_name": "Edit", "tool_input": {"file_path": str(project / "file.txt")}}, False),
        ("git merge-base allowed", {"tool_name": "Bash", "tool_input": {"command": "git merge-base HEAD main"}}, False),
        ("git merge-tree allowed", {"tool_name": "Bash", "tool_input": {"command": "git merge-tree HEAD main"}}, False),
        ("git merge denied", {"tool_name": "Bash", "tool_input": {"command": "git merge main"}}, True),
        ("shell project write denied", {"tool_name": "Bash", "tool_input": {"command": "printf bad > source.txt"}}, True),
    ]
    lines = []
    for name, event, expected in cases:
        output = guard.handle({**base, **event}, project)
        denied = output.get("hookSpecificOutput", {}).get("permissionDecision") == "deny"
        if denied != expected:
            raise ValueError("Smoke FAIL: " + name)
        lines.append("PASS " + name)
    lines.append("Synthetic smoke only: no attempted edits or shell commands were executed. Confirm actual subagent models in /tasks.")
    if os.environ.get("CLAUDE_CODE_SUBAGENT_MODEL_FORCE") == "1":
        lines.append("WARNING: CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1 can override configured subagent models.")
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="XPowers opt-in Claude Code routing")
    parser.add_argument("action", choices=["install", "on", "off", "status", "smoke", "guard", "session-start"])
    parser.add_argument("--project", type=Path, default=Path.cwd())
    parser.add_argument("--preset", choices=common.PRESETS)
    parser.add_argument("--restore", action="store_true")
    parser.add_argument("--session")
    args = parser.parse_args()
    if args.action != "install" and (args.preset or args.restore):
        parser.error("--preset and --restore are installation options")
    project = args.project.resolve()
    try:
        if args.action == "install":
            import install
            if args.restore and args.preset:
                raise ValueError("--restore and --preset cannot be combined")
            print(install.restore(project) if args.restore else install.install(project, args.preset))
        elif args.action == "guard":
            import guard
            data = json.load(sys.stdin)
            print(json.dumps(guard.handle(data, project)))
        elif args.action == "session-start":
            data = json.load(sys.stdin)
            if active(project, data.get("session_id")):
                config = common.load_config(project)
                check_profile(project, config)
                print(json.dumps({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": common.workflow(config)}}))
            else:
                print("{}")
        elif args.action == "off":
            common.atomic_json(common.session_path(project, args.session), {"enabled": False})
            print("XPowers routing is OFF for this session.")
        elif args.action == "on":
            import install
            # Restore holds this same lock while removing files and disabling
            # sessions. Validation and activation must be one serialized step.
            with install._locked(project):
                config = common.load_config(project)
                check_profile(project, config)
                common.atomic_json(common.session_path(project, args.session), {"enabled": True})
            print(common.workflow(config))
        elif args.action == "status":
            print("ON" if active(project, args.session) else "OFF")
        elif args.action == "smoke":
            print(smoke(project, args.session))
    except (OSError, ValueError, TypeError, KeyError) as error:
        if args.action == "guard":
            print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "XPowers routing guard failed: " + str(error)}}))
            return 0
        print("XPowers routing: " + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
