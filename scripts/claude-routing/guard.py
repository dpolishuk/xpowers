"""PreToolUse policy for the opt-in Claude coordinator workflow.

This is a workflow boundary, not an operating-system sandbox. In particular,
workers and verifiers execute repository programs with the user's permissions.
Only the coordinator and read-only agents use the conservative shell allowlist.
"""

import json
import os
from pathlib import Path
import shlex

import common


PREFIX = "xpowers-routing-"
DELEGATES = {"explorer", "worker", "verifier", "senior", "reviewer"}
READ_TOOLS = {"Read", "Glob", "Grep", "WebFetch", "WebSearch", "AskUserQuestion", "TaskOutput"}
EDIT_TOOLS = {"Write", "Edit", "NotebookEdit"}
READ_COMMANDS = {"pwd", "ls", "cat", "rg", "grep", "head", "tail", "wc"}
GIT_QUERIES = {"rev-parse", "merge-base", "ls-tree"}


def deny(reason):
    return {"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": f"XPowers routing: {reason}",
    }}


def _inside(path, directory):
    try:
        path.relative_to(directory)
        return True
    except ValueError:
        # Path.resolve() follows symlinks but does not normalize filename case
        # on case-insensitive volumes. Existing ancestors identify those aliases.
        for ancestor in (path, *path.parents):
            try:
                if ancestor.samefile(directory):
                    return True
            except FileNotFoundError:
                continue
        return False


def _paths(value, cwd):
    """Keep both lexical containment and resolved symlink containment."""
    if not isinstance(value, str) or not value.strip() or "\x00" in value:
        raise ValueError("A valid file path is required")
    path = Path(value).expanduser()
    if not path.is_absolute():
        path = cwd / path
    lexical = Path(os.path.abspath(path))
    return lexical, lexical.resolve()


def _contains_either(paths, directory):
    directory = Path(os.path.abspath(directory))
    return _inside(paths[0], directory) or _inside(paths[1], directory.resolve())


def _protected(paths, project):
    controls = [
        project / ".claude" / "routing.json",
        project / ".claude" / "xpowers-routing",
        project / ".claude" / "settings.json",
        project / ".claude" / "settings.local.json",
        common.control_dir(project),
        Path.home() / ".claude" / "xpowers-routing",
        Path.home() / ".claude" / "settings.json",
        Path.home() / ".claude" / "settings.local.json",
        common.claude_config_dir() / "settings.json",
        common.claude_config_dir() / "settings.local.json",
    ]
    controls.extend(project / ".claude" / "agents" / f"{PREFIX}{role}.md" for role in DELEGATES | {"coordinator"})
    controls.extend(project / ".claude" / "commands" / name for name in
                    ("routing-on.md", "routing-off.md", "routing-smoke-test.md"))
    return any(_contains_either(paths, control) for control in controls)


def _tokens(command):
    if not isinstance(command, str) or not command.strip():
        raise ValueError("A nonempty shell command is required")
    if any(ord(char) < 32 and char != "\t" for char in command):
        raise ValueError("Multiline commands and shell control characters are not allowed")
    # shlex does not expand globs/braces, but Bash does before executing Git.
    # Preserve quoted literal search patterns while refusing unquoted expansion
    # that could turn an innocuous-looking argument into --output or --ext-diff.
    quote = None
    escaped = False
    for char in command:
        if escaped:
            escaped = False
            continue
        if quote == "'":
            if char == "'":
                quote = None
            continue
        if char == "\\":
            escaped = True
            continue
        # Single-quoted or escaped dollars/backticks are literal search text.
        # Everywhere else they can evaluate shell substitutions, including
        # inside double quotes, and must not reach the command allowlist.
        if char in "`$":
            raise ValueError("Shell expansion is not allowed in coordinator commands")
        if quote == '"':
            if char == '"':
                quote = None
            continue
        if char in {"'", '"'}:
            quote = char
        elif char in "{}*?[]":
            raise ValueError("Quote literal patterns; unquoted shell brace and glob expansion is not allowed")
    lexer = shlex.shlex(command, posix=True, punctuation_chars=";&|<>()")
    lexer.whitespace_split = True
    lexer.commenters = ""
    tokens = list(lexer)
    if any(token and all(char in ";&|<>()" for char in token) and token != "|" for token in tokens):
        raise ValueError("Shell redirection, chaining and subshells are not allowed")
    return tokens


def _git_query(arguments):
    index = 0
    no_pager = False
    no_lazy_fetch = False
    while index < len(arguments):
        option = arguments[index]
        if option == "--no-pager":
            no_pager = True
            index += 1
        elif option == "--no-lazy-fetch":
            no_lazy_fetch = True
            index += 1
        elif option == "--no-optional-locks":
            index += 1
        elif option == "-C" and index + 1 < len(arguments):
            index += 2
        else:
            break
    if not no_pager or not no_lazy_fetch or index == len(arguments):
        return False
    subcommand = arguments[index]
    options = arguments[index + 1:]
    # These can write files or start programs even on otherwise read-only queries.
    forbidden = {
        "--output", "--ext-diff", "--textconv", "--write-tree", "--help",
        "--config-env", "--git-dir", "--work-tree", "--namespace", "--exec-path",
    }
    if any(
        option in {"-c", "-h"} or (
            option.startswith("--") and option != "--"
            and any(flag.startswith(option.split("=", 1)[0]) for flag in forbidden)
        )
        for option in options
    ):
        return False
    if subcommand == "branch":
        return options == ["--show-current"]
    return subcommand in GIT_QUERIES


def _readonly_command(arguments):
    if not arguments:
        return False
    command, *options = arguments
    if command == "git":
        return _git_query(options)
    if command not in READ_COMMANDS:
        return False
    if command == "rg":
        executing = {"--pre", "--pre-glob", "--hostname-bin"}
        if any(option.split("=", 1)[0] in executing for option in options):
            return False
    return True


def _control_command(tokens, project, session_id):
    if len(tokens) != 7 or tokens[0] != "python3":
        return False
    if tokens[2] not in {"on", "off", "smoke", "status"}:
        return False
    if tokens[3] != "--project" or tokens[5] != "--session" or tokens[6] != session_id:
        return False
    expected = project / ".claude" / "xpowers-routing" / "cli.py"
    return Path(tokens[1]) == expected and Path(tokens[4]) == project


def _shell_allowed(command, project, session_id, allow_control):
    tokens = _tokens(command)
    if allow_control and _control_command(tokens, project, session_id):
        return True
    segments = [[]]
    for token in tokens:
        if token == "|":
            segments.append([])
        else:
            segments[-1].append(token)
    return all(_readonly_command(segment) for segment in segments)


def _dispatch(tool_input, config):
    name = tool_input.get("subagent_type")
    role = name[len(PREFIX):] if isinstance(name, str) and name.startswith(PREFIX) else None
    if role not in DELEGATES:
        return deny("Delegate using a configured xpowers-routing agent name")
    if role in {"verifier", "reviewer"} and any(tool_input.get(key) for key in ("resume", "fork", "fork_context")):
        return deny("Verifier and reviewer must start as separate agents with fresh context; do not resume or fork")
    model = tool_input.get("model")
    if model is not None and model != config["roles"][role]["model"]:
        return deny("The explicit agent model differs from .claude/routing.json; omit it to use the configured model")
    return {}


def handle(payload, project):
    """Return an empty allow response or Claude's structured deny response."""
    if not isinstance(payload, dict):
        return deny("Invalid hook payload")
    session_id = payload.get("session_id")
    if not isinstance(session_id, str) or not session_id.strip():
        return deny("Missing session identity; cannot determine routing state safely")
    project = Path(project).absolute()
    # The exact disable command remains usable when a damaged configuration
    # would otherwise deny every tool. No general Python execution is allowed.
    if payload.get("tool_name") == "Bash" and not payload.get("agent_id") and isinstance(payload.get("tool_input"), dict):
        try:
            tokens = _tokens(payload["tool_input"].get("command"))
            if _control_command(tokens, project, session_id) and tokens[2] == "off":
                return {}
        except ValueError:
            pass
    try:
        state_path = common.session_path(project, session_id)
        try:
            state = json.loads(state_path.read_text())
        except FileNotFoundError:
            return {}
        if not isinstance(state, dict) or type(state.get("enabled")) is not bool:
            return deny("Invalid routing state; repair it with the routing CLI")
        if not state["enabled"]:
            return {}
        config = common.load_config(project)
        common.check_generated(project, config)
    except (OSError, ValueError, TypeError, KeyError):
        return deny("Cannot validate active routing configuration or state; repair it with the routing CLI")

    agent_id = payload.get("agent_id")
    role = "coordinator"
    if agent_id:
        if not isinstance(agent_id, str) or not agent_id.strip():
            return deny("Invalid delegated agent identity")
        name = payload.get("agent_type")
        role = name[len(PREFIX):] if isinstance(name, str) and name.startswith(PREFIX) else None
        if role not in DELEGATES:
            return deny("Unknown delegated agent; use a configured xpowers-routing role")

    tool = payload.get("tool_name")
    tool_input = payload.get("tool_input")
    if not isinstance(tool, str) or not isinstance(tool_input, dict):
        return deny("Invalid tool name or input")
    if tool in READ_TOOLS:
        return {}
    if tool in EDIT_TOOLS:
        try:
            cwd = payload.get("cwd", str(project))
            if not isinstance(cwd, str) or not Path(cwd).is_absolute():
                return deny("A valid absolute cwd is required for file writes")
            key = "notebook_path" if tool == "NotebookEdit" else "file_path"
            paths = _paths(tool_input.get(key), Path(cwd))
            if _protected(paths, project):
                return deny("Routing controls are protected; use the routing CLI for session changes")
            if role not in {"worker", "senior"} and _contains_either(paths, project):
                return deny("This role cannot edit project files; return the defect and task card to a worker or senior")
            return {}
        except (OSError, ValueError, RuntimeError):
            return deny("Cannot safely resolve the file path")
    if tool in {"Agent", "Task"}:
        if role in {"explorer", "reviewer", "verifier"}:
            return deny("This role must report findings to the coordinator rather than launching another agent")
        return _dispatch(tool_input, config)
    if tool == "Bash":
        if role in {"worker", "senior", "verifier"}:
            return {}
        try:
            if _shell_allowed(tool_input.get("command"), project, session_id, role == "coordinator"):
                return {}
        except ValueError:
            pass
        return deny("Only explicit read-only shell queries are allowed; delegate implementation or tests to the configured agent")
    return deny("This tool is not allowed by the active routing policy; delegate the operation to a configured agent")
