"""Install and restore the opt-in project-local Claude routing profile."""

import base64
import contextlib
import fcntl
import json
import os
from pathlib import Path
import shlex
import stat
import tempfile

import common


ROLES = ("explorer", "worker", "verifier", "senior", "reviewer")
ROLE_INSTRUCTIONS = {
    "explorer": "Locate relevant files, symbols, callers, and tests. Report exact paths and evidence. Do not edit files or implement changes.",
    "worker": "Implement the assigned task card and its acceptance criteria. Preserve the coordinator's invariants, respect file ownership, write meaningful tests, and report the diff, checks, and evidence. Return unresolved defects and failed attempts for escalation; do not silently broaden scope.",
    "verifier": "Independently run checks against another agent's diff. Start in a fresh context, never the author's thread and never a resumed implementation agent. Inspect acceptance criteria and run relevant tests, reporting exact commands, exit codes, and evidence. Never change source files or fix the author's defects; return failures to the coordinator. Test tools may create normal build artifacts.",
    "senior": "Handle difficult work, money, concurrency, data migrations, and escalations after worker failures. Preserve task-card invariants and report evidence and remaining risks. Respect the configured attempt budget; when exhausted, stop and return the unresolved state for independent review rather than claiming success.",
    "reviewer": "Perform semantic review of risky changes using a fresh context. You must be a separate agent, never the author and never a continuation or resume of the author's thread. Sharing the author's model is allowed. Inspect invariants, money, concurrency, and data migrations; report actionable findings with file references. Never edit project files or implement fixes.",
}


def _json_bytes(value):
    return (json.dumps(value, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def _safe_target(path, root):
    """Reject symlinks, including broken links and existing target ancestors."""
    relative = path.relative_to(root)
    current = root
    for part in (None, *relative.parts):
        if part is not None:
            current = current / part
        if current.is_symlink():
            raise ValueError(f"Refusing symlinked routing target: {current}")
        if current != path and current.exists() and not current.is_dir():
            raise ValueError(f"Routing target ancestor is not a directory: {current}")


def _snapshot(path):
    if path.is_symlink():
        raise ValueError(f"Refusing symlinked routing target: {path}")
    if not path.exists():
        return None
    if not path.is_file():
        raise ValueError(f"Routing target is not a regular file: {path}")
    return {"data": base64.b64encode(path.read_bytes()).decode("ascii"),
            "mode": stat.S_IMODE(path.stat().st_mode)}


def _content(data, mode=0o644):
    return {"data": base64.b64encode(data).decode("ascii"), "mode": mode}


def _decode(snapshot):
    return base64.b64decode(snapshot["data"], validate=True)


def _atomic_write(path, snapshot):
    if snapshot is None:
        path.unlink(missing_ok=True)
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".xpowers-routing-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(_decode(snapshot))
            stream.flush()
            os.fsync(stream.fileno())
            os.fchmod(stream.fileno(), snapshot["mode"])
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _commit(plan):
    """Preflight callers supply complete plans; roll back filesystem failures."""
    before = {target: _snapshot(target) for target in plan}
    missing_directories = set()
    for target in plan:
        parent = target.parent
        while not parent.exists():
            missing_directories.add(parent)
            parent = parent.parent
    written = []
    try:
        for target, after in plan.items():
            if before[target] != after:
                _atomic_write(target, after)
                written.append(target)
    except Exception:
        for target in reversed(written):
            _atomic_write(target, before[target])
        for directory in sorted(missing_directories, key=lambda item: len(item.parts), reverse=True):
            try:
                directory.rmdir()
            except OSError:
                pass
        raise


@contextlib.contextmanager
def _locked(project):
    control = common.control_dir(project)
    if control.resolve().is_relative_to(project):
        raise ValueError("Routing control state must live outside the project; choose a project below your home directory")
    # Do not follow user-replaced control directories or lock files.
    home = Path.home().absolute()
    _safe_target(control, home if control.is_relative_to(home) else control.parent)
    control.mkdir(parents=True, exist_ok=True)
    lock = control / "install.lock"
    if lock.is_symlink():
        raise ValueError(f"Refusing symlinked routing lock: {lock}")
    with lock.open("a+b") as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        try:
            yield control
        finally:
            fcntl.flock(stream, fcntl.LOCK_UN)


def _read_json(path, default=None):
    snapshot = _snapshot(path)
    if snapshot is None:
        return default
    value = json.loads(_decode(snapshot))
    if not isinstance(value, dict):
        raise ValueError(f"Expected a JSON object in {path}")
    return value


def _read_manifest(control, project):
    manifest = _read_json(control / "install-manifest.json")
    if manifest is None:
        return None
    if manifest.get("version") != 1 or manifest.get("project") != str(project):
        raise ValueError("Invalid routing installation manifest")
    for name in manifest.get("files", {}):
        relative = Path(name)
        if relative.is_absolute() or ".." in relative.parts:
            raise ValueError("Invalid routing manifest path")
    return manifest


def _settings(path):
    value = _read_json(path, {})
    hooks = value.get("hooks", {})
    if not isinstance(hooks, dict):
        raise ValueError("Claude settings.hooks must be an object")
    for event, entries in hooks.items():
        if not isinstance(entries, list) or not all(isinstance(entry, dict) for entry in entries):
            raise ValueError(f"Claude settings.hooks.{event} must be a list of objects")
    return value


def _hook_entries(project):
    cli = project / ".claude" / "xpowers-routing" / "cli.py"
    invocation = f"python3 {shlex.quote(str(cli))}"
    target = f"--project {shlex.quote(str(project))}"
    return {
        "PreToolUse": {"matcher": ".*", "hooks": [{"type": "command", "command": f"{invocation} guard {target}", "timeout": 5}]},
        "SessionStart": {"hooks": [{"type": "command", "command": f"{invocation} session-start {target}", "timeout": 5}]},
    }


def _check_owned_hooks(settings, owned):
    hooks = settings.get("hooks", {})
    for event, entry in owned.items():
        if entry not in hooks.get(event, []):
            raise ValueError(f"Routing hook was modified or removed: {event}; restore it before changing the installation")


def _agent(role, config):
    policy = config["roles"][role]
    frontmatter = ["---", f"name: xpowers-routing-{role}",
                   f"description: Use when the coordinator delegates the routing {role} role.",
                   f"model: {json.dumps(policy['model'])}"]
    # Haiku does not expose native effort controls; the config retains intent.
    if not policy["model"].startswith("claude-haiku-4-5"):
        frontmatter.append(f"effort: {policy['effort']}")
    frontmatter.append(f"maxTurns: {policy['maxTurns']}")
    if role in ("explorer", "reviewer"):
        frontmatter.append("tools: Read, Glob, Grep")
    elif role == "verifier":
        frontmatter.append("tools: Read, Glob, Grep, Bash")
    frontmatter.extend(["---", "", ROLE_INSTRUCTIONS[role], ""])
    return "\n".join(frontmatter).encode("utf-8")


def _command(name, action, project):
    descriptions = {
        "on": "Use to enable coordinator routing for the current Claude Code session.",
        "off": "Use to disable coordinator routing for the current Claude Code session.",
        "smoke": "Use to check installed routing configuration and guard behavior.",
    }
    cli = project / ".claude" / "xpowers-routing" / "cli.py"
    invocation = (f"python3 {shlex.quote(str(cli))} {action} "
                  f'--project {shlex.quote(str(project))} --session "${{CLAUDE_SESSION_ID}}"')
    lines = ["---", f"description: {descriptions[action]}", "disable-model-invocation: true", "---", "",
             "Run the following command with Bash and report its result:", "", "```bash", invocation, "```", ""]
    if action == "on":
        lines.extend(["Adopt the workflow returned by the command only after it succeeds. It reads the current routing configuration. If activation fails, report the error and do not claim routing is enabled.", ""])
    return "\n".join(lines).encode("utf-8")


def _managed_files(project, config, config_bytes):
    files = {"routing.json": config_bytes,
             "xpowers-routing/generated-config.json": _json_bytes(config)}
    for source in sorted(Path(__file__).parent.glob("*.py")):
        files[f"xpowers-routing/{source.name}"] = source.read_bytes()
    for role in ROLES:
        files[f"agents/xpowers-routing-{role}.md"] = _agent(role, config)
    for name, action in (("routing-on", "on"), ("routing-off", "off"), ("routing-smoke-test", "smoke")):
        files[f"commands/{name}.md"] = _command(name, action, project)
    return files


def install(project: Path, preset=None):
    project = Path(project).resolve(strict=True)
    if not project.is_dir():
        raise ValueError("Project must be an existing directory")
    claude = project / ".claude"
    _safe_target(claude, project)
    with _locked(project) as control:
        config_path = claude / "routing.json"
        settings_path = claude / "settings.json"
        for target in (config_path, settings_path):
            _safe_target(target, project)
        # Validate existing data even when an explicit preset would replace it.
        old_config = common.load_config(project) if config_path.exists() else None
        config = common.validate_config(common.preset_config(preset) if preset else old_config or common.preset_config("opus"))
        config_bytes = config_path.read_bytes() if old_config is not None and preset is None else _json_bytes(config)
        settings = _settings(settings_path)
        manifest = _read_manifest(control, project)
        files = _managed_files(project, config, config_bytes)
        previous_files = manifest["files"] if manifest else {}
        for name in set(files) | set(previous_files):
            target = claude / name
            _safe_target(target, project)
            current = _snapshot(target)
            if name in previous_files and name != "routing.json" and current != previous_files[name]["installed"]:
                raise ValueError(f"Managed routing file was modified: {target}")
        owned_hooks = dict(manifest["ownedHooks"]) if manifest else {}
        _check_owned_hooks(settings, owned_hooks)
        before_settings = _snapshot(settings_path)
        hooks = settings.setdefault("hooks", {})
        for event, entry in _hook_entries(project).items():
            entries = hooks.setdefault(event, [])
            if entry not in entries:
                entries.append(entry)
                owned_hooks[event] = entry
        plan = {}
        snapshots = dict(previous_files)
        for name, data in files.items():
            target = claude / name
            current = _snapshot(target)
            desired = _content(data, current["mode"] if current else 0o644)
            snapshots[name] = {"before": previous_files[name]["before"] if name in previous_files else current,
                               "installed": desired}
            plan[target] = desired
        desired_settings = _content(_json_bytes(settings), before_settings["mode"] if before_settings else 0o644)
        plan[settings_path] = desired_settings
        updated = {"version": 1, "project": str(project), "files": snapshots, "ownedHooks": owned_hooks,
                   "settings": {"before": manifest["settings"]["before"] if manifest else before_settings,
                                "installed": desired_settings}}
        plan[control / "install-manifest.json"] = _content(_json_bytes(updated), 0o600)
        _commit(plan)
    return f"Installed XPowers Claude routing ({config['preset']}) in {project}. Start a new Claude Code session and run /routing-on, then /routing-smoke-test."


def restore(project: Path):
    project = Path(project).resolve(strict=True)
    claude = project / ".claude"
    _safe_target(claude, project)
    with _locked(project) as control:
        manifest = _read_manifest(control, project)
        if manifest is None:
            return "No XPowers routing installation to restore."
        plan = {}
        for name, snapshots in manifest["files"].items():
            target = claude / name
            _safe_target(target, project)
            if _snapshot(target) != snapshots["installed"]:
                raise ValueError(f"Managed routing file was modified: {target}; resolve the conflict before restore")
            plan[target] = snapshots["before"]
        settings_path = claude / "settings.json"
        _safe_target(settings_path, project)
        settings = _settings(settings_path)
        _check_owned_hooks(settings, manifest["ownedHooks"])
        current_settings = _snapshot(settings_path)
        original = manifest["settings"]["before"]
        original_value = json.loads(_decode(original)) if original else {}
        original_hooks = original_value.get("hooks", {})
        hooks = settings.get("hooks", {})
        for event, entry in manifest["ownedHooks"].items():
            hooks[event].remove(entry)
            if not hooks[event] and event not in original_hooks:
                del hooks[event]
        if not hooks and "hooks" not in original_value:
            settings.pop("hooks", None)
        # Reinstall may have incorporated later user settings. Only recover the
        # exact original bytes when removing our hooks recovers its full value.
        if settings == original_value and (original is None or current_settings["mode"] == original["mode"]):
            plan[settings_path] = original
        else:
            plan[settings_path] = (_content(_json_bytes(settings), current_settings["mode"])
                                   if settings or original is not None else None)
        # Prevent restoring then reinstalling from reviving this session's guard.
        sessions = control / "sessions"
        _safe_target(sessions, control)
        for state_path in sorted(sessions.glob("*.json")):
            _safe_target(state_path, control)
            state = _read_json(state_path)
            if type(state.get("enabled")) is not bool:
                raise ValueError(f"Invalid routing session state: {state_path}")
            state["enabled"] = False
            current = _snapshot(state_path)
            plan[state_path] = _content(_json_bytes(state), current["mode"])
        plan[control / "install-manifest.json"] = None
        _commit(plan)
        for directory in (claude / "xpowers-routing", claude / "agents", claude / "commands", claude):
            try:
                directory.rmdir()
            except OSError:
                pass  # Preserve directories containing unrelated user files.
    return f"Restored pre-install XPowers routing files in {project}; unrelated settings were preserved."
