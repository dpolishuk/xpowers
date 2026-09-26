#!/usr/bin/env python3
"""Installer entrypoint and fast, offline Claude Code hooks."""

import sys

if sys.version_info < (3, 9):
    print("XPowers Claude routing requires Python 3.9 or newer.", file=sys.stderr)
    raise SystemExit(1)

sys.dont_write_bytecode = True

import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import time

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
    return manifest


ACTIVATION_TTL_SECONDS = 300


def _installed_cli(project):
    expected = project / ".claude/xpowers-routing/cli.py"
    if Path(__file__).resolve(strict=True) != expected.resolve(strict=True):
        raise ValueError("Routing activation must run through the installed project CLI")
    return expected


def _profile_binding(project):
    import install
    config = common.load_config(project)
    manifest = check_profile(project, config)
    installation_id = manifest.get("installationId")
    if (not isinstance(installation_id, str) or len(installation_id) != 32
            or any(char not in "0123456789abcdef" for char in installation_id)):
        raise ValueError("Routing ownership manifest has an invalid installation identity")
    manifest_path = common.control_dir(project) / "install-manifest.json"
    snapshot = install._snapshot(manifest_path)
    if snapshot is None or json.loads(install._decode(snapshot)) != manifest:
        raise ValueError("Routing ownership manifest changed during profile validation")
    digest = hashlib.sha256(install._decode(snapshot)).hexdigest()
    return config, installation_id, digest


def _issue_activation(project, payload, result):
    """Attest an exact live PreToolUse observation without changing policy."""
    if result != {} or payload.get("hook_event_name") != "PreToolUse":
        return result
    session_id = payload.get("session_id")
    tool_use_id = payload.get("tool_use_id")
    if (not isinstance(session_id, str) or not session_id.strip()
            or not isinstance(tool_use_id, str) or not tool_use_id.strip()
            or len(tool_use_id) > 512 or payload.get("agent_id") is not None
            or payload.get("tool_name") != "Bash"):
        return result
    tool_input = payload.get("tool_input")
    if not isinstance(tool_input, dict):
        return result
    import guard
    try:
        tokens = guard._tokens(tool_input.get("command"))
    except ValueError:
        return result
    except AttributeError as error:
        # A locally replaced guard may still return allow. Validate its owned
        # runtime snapshot so the hook emits the normal structured denial.
        import install
        with install._locked(project):
            _profile_binding(project)
        raise ValueError("Installed routing guard cannot validate activation") from error
    if not guard._control_command(tokens, project, session_id) or tokens[2] != "on":
        return result
    expected = _installed_cli(project)
    if Path(tokens[1]).resolve(strict=True) != expected.resolve(strict=True):
        return result
    import install
    with install._locked(project) as control:
        _, installation_id, manifest_digest = _profile_binding(project)
        token = secrets.token_hex(32)
        proof_path = common.activation_path(project, session_id)
        install._safe_target(proof_path, control)
        receipt = {
            "version": 1,
            "project": str(project),
            "session": session_id,
            "toolUseId": tool_use_id,
            "installationId": installation_id,
            "manifestSha256": manifest_digest,
            "token": token,
            "issuedAt": time.time(),
        }
        install._commit({proof_path: install._content(install._json_bytes(receipt), 0o600)})
    updated = dict(tool_input)
    updated["command"] = tool_input["command"] + " --hook-token " + token
    return {"hookSpecificOutput": {"hookEventName": "PreToolUse", "updatedInput": updated}}


def _activate(project, session_id, token):
    import install
    state_path = common.session_path(project, session_id)
    proof_path = common.activation_path(project, session_id)
    with install._locked(project) as control:
        install._safe_target(state_path, control)
        install._safe_target(proof_path, control)
        state_snapshot = install._snapshot(state_path)
        state_mode = state_snapshot["mode"] if state_snapshot else 0o600
        disabled = install._content(install._json_bytes({"enabled": False}), state_mode)
        receipt_error = None
        try:
            receipt = install._read_json(proof_path)
        except (OSError, ValueError, TypeError) as error:
            receipt = None
            receipt_error = error
        # Every attempt consumes its observed proof and leaves the session OFF
        # unless all validation succeeds and the final enable commit completes.
        install._commit({proof_path: None, state_path: disabled})
        _installed_cli(project)
        if receipt_error is not None:
            raise receipt_error
        config, installation_id, manifest_digest = _profile_binding(project)
        now = time.time()
        issued_at = receipt.get("issuedAt") if isinstance(receipt, dict) else None
        valid_time = (isinstance(issued_at, (int, float)) and not isinstance(issued_at, bool)
                      and 0 <= now - issued_at <= ACTIVATION_TTL_SECONDS)
        valid = (isinstance(receipt, dict) and type(receipt.get("version")) is int and receipt["version"] == 1
                 and receipt.get("project") == str(project) and receipt.get("session") == session_id
                 and isinstance(receipt.get("toolUseId"), str) and receipt["toolUseId"].strip()
                 and receipt.get("installationId") == installation_id
                 and receipt.get("manifestSha256") == manifest_digest
                 and isinstance(receipt.get("token"), str) and isinstance(token, str)
                 and secrets.compare_digest(receipt["token"], token) and valid_time)
        if not valid:
            raise ValueError("Routing activation requires a fresh matching PreToolUse hook proof")
        enabled = install._content(install._json_bytes({"enabled": True}), state_mode)
        install._commit({state_path: enabled})
    return config


def _disable(project, session_id):
    import install
    state_path = common.session_path(project, session_id)
    proof_path = common.activation_path(project, session_id)
    with install._locked(project) as control:
        install._safe_target(state_path, control)
        install._safe_target(proof_path, control)
        state_snapshot = install._snapshot(state_path)
        state_mode = state_snapshot["mode"] if state_snapshot else 0o600
        disabled = install._content(install._json_bytes({"enabled": False}), state_mode)
        install._commit({proof_path: None, state_path: disabled})


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
        ("bounded git query allowed", {"tool_name": "Bash", "tool_input": {"command": "git --no-pager --no-lazy-fetch merge-base HEAD main"}}, False),
        ("git merge-tree denied", {"tool_name": "Bash", "tool_input": {"command": "git --no-pager --no-lazy-fetch merge-tree HEAD main"}}, True),
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
    parser.add_argument("--hook-token", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.action != "install" and (args.preset or args.restore):
        parser.error("--preset and --restore are installation options")
    if args.action != "on" and args.hook_token is not None:
        parser.error("--hook-token is private to observed routing activation")
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
            result = guard.handle(data, project)
            print(json.dumps(_issue_activation(project, data, result)))
        elif args.action == "session-start":
            data = json.load(sys.stdin)
            if active(project, data.get("session_id")):
                config = common.load_config(project)
                check_profile(project, config)
                print(json.dumps({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": common.workflow(config)}}))
            else:
                print("{}")
        elif args.action == "off":
            _disable(project, args.session)
            print("XPowers routing is OFF for this session.")
        elif args.action == "on":
            config = _activate(project, args.session, args.hook_token)
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
