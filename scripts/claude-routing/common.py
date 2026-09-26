"""Shared configuration and external session state for XPowers Claude routing."""

import copy
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile

ROLES = ("coordinator", "explorer", "worker", "verifier", "senior", "reviewer")
PRESETS = ("opus", "fable-review", "fable-coordinator")
MIN_CLAUDE_VERSION = "2.1.280"


def preset_config(name="opus"):
    if name not in PRESETS:
        raise ValueError("Unknown routing preset: " + str(name))
    config = {
        "version": 1,
        "preset": name,
        "roles": {
            "coordinator": {"model": "claude-opus-5-5", "effort": "high"},
            "explorer": {"model": "claude-haiku-4-5-20251001", "effort": "low", "maxTurns": 40},
            "worker": {"model": "claude-opus-5-5", "effort": "medium", "maxTurns": 80},
            "verifier": {"model": "claude-sonnet-5", "effort": "medium", "maxTurns": 80},
            "senior": {"model": "claude-opus-5-5", "effort": "high", "maxTurns": 80},
            "reviewer": {"model": "claude-opus-5-5", "effort": "high", "maxTurns": 60},
        },
        "escalation": {"workerAttempts": 2, "seniorAttempts": 2},
        "review": {
            "riskTags": ["money", "concurrency", "data-migration"],
            "afterSeniorExhaustion": True,
        },
    }
    if name == "fable-review":
        config["roles"]["reviewer"]["model"] = "claude-fable-5-1"
    elif name == "fable-coordinator":
        config["roles"]["coordinator"]["model"] = "claude-fable-5-1"
    return config


default_config = preset_config


def claude_config_dir():
    return Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude").expanduser().resolve()


def _positive_int(value, name, maximum):
    if type(value) is not int or not 1 <= value <= maximum:
        raise ValueError(f"{name} must be an integer between 1 and {maximum}")


def validate_config(config):
    if not isinstance(config, dict) or type(config.get("version")) is not int or config["version"] != 1:
        raise ValueError("routing.json requires version: 1")
    if config.get("preset") not in PRESETS:
        raise ValueError("routing.json has an unknown preset")
    roles = config.get("roles")
    if not isinstance(roles, dict) or set(roles) != set(ROLES):
        raise ValueError("routing.json must define exactly these roles: " + ", ".join(ROLES))
    for name, role in roles.items():
        if not isinstance(role, dict):
            raise ValueError(f"roles.{name} must be an object")
        model = role.get("model")
        if not isinstance(model, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}", model):
            raise ValueError(f"roles.{name}.model must be a nonempty model ID (no whitespace)")
        if role.get("effort") not in ("low", "medium", "high", "xhigh", "max"):
            raise ValueError(f"roles.{name}.effort is invalid")
        if name != "coordinator":
            _positive_int(role.get("maxTurns"), f"roles.{name}.maxTurns", 1000)
    verifier = roles["verifier"]["model"]
    if verifier in (roles["worker"]["model"], roles["senior"]["model"]):
        raise ValueError("verifier must use a different model from worker and senior")
    escalation = config.get("escalation")
    if not isinstance(escalation, dict):
        raise ValueError("escalation must be an object")
    for key in ("workerAttempts", "seniorAttempts"):
        _positive_int(escalation.get(key), "escalation." + key, 20)
    review = config.get("review")
    if not isinstance(review, dict) or type(review.get("afterSeniorExhaustion")) is not bool:
        raise ValueError("review.afterSeniorExhaustion must be a boolean")
    tags = review.get("riskTags")
    if not isinstance(tags, list) or not tags or any(not isinstance(tag, str) or not re.fullmatch(r"[a-z][a-z0-9-]{0,63}", tag) for tag in tags):
        raise ValueError("review.riskTags must be a nonempty list of lowercase risk labels")
    if len(set(tags)) != len(tags):
        raise ValueError("review.riskTags must not contain duplicates")
    return copy.deepcopy(config)


def load_config(project):
    return validate_config(json.loads((Path(project) / ".claude/routing.json").read_text()))


def control_dir(project):
    key = hashlib.sha256(os.fsencode(Path(project).resolve())).hexdigest()[:24]
    return Path.home() / ".claude" / "xpowers-routing" / key


def session_path(project, session_id):
    if not isinstance(session_id, str) or not session_id.strip() or len(session_id) > 512:
        raise ValueError("A nonempty Claude session ID is required")
    key = hashlib.sha256(session_id.encode()).hexdigest()
    return control_dir(project) / "sessions" / (key + ".json")


def activation_path(project, session_id):
    if not isinstance(session_id, str) or not session_id.strip() or len(session_id) > 512:
        raise ValueError("A nonempty Claude session ID is required")
    key = hashlib.sha256(session_id.encode()).hexdigest()
    return control_dir(project) / "activation-proofs" / (key + ".json")


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(prefix=".routing-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as handle:
            json.dump(value, handle, indent=2, ensure_ascii=False)
            handle.write("\n")
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def check_generated(project, config):
    generated = Path(project) / ".claude/xpowers-routing/generated-config.json"
    try:
        snapshot = json.loads(generated.read_text())
    except (OSError, ValueError) as error:
        raise ValueError("Routing is not installed; run setup-claude-routing.sh first") from error
    if snapshot != config:
        raise ValueError("routing.json changed: rerun setup-claude-routing.sh without a preset to regenerate agents, then start a new session")


def workflow(config):
    validate_config(config)
    rows = []
    for name in ROLES:
        role = config["roles"][name]
        effort = role["effort"]
        if role["model"].startswith("claude-haiku-4-5"):
            effort += " (Haiku 4.5 effort is unsupported; routing intent only)"
        budget = f", maxTurns={role['maxTurns']}" if "maxTurns" in role else ""
        rows.append(f"- {name}: {role['model']}, effort={effort}{budget}")
    escalation = config["escalation"]
    risks = ", ".join(config["review"]["riskTags"])
    exhausted = "Also require verifier AND reviewer after the senior attempt budget is exhausted." if config["review"]["afterSeniorExhaustion"] else "Senior budget exhaustion requires coordinator escalation to the user."
    return "\n".join([
        "XPowers Claude routing is ON for this session.",
        "You are the coordinator. Define invariants, scope, risk tags and acceptance criteria; delegate source changes and test execution. Return defects to the author with evidence.",
        *rows,
        f"Select the coordinator model with /model {config['roles']['coordinator']['model']} and the configured effort with /effort {config['roles']['coordinator']['effort']}. This command cannot change the running model.",
        "Ordinary work: worker -> verifier -> coordinator. The verifier independently runs checks against the author's exact diff and reports commands, outcomes and limitations.",
        f"Risk tags requiring BOTH verifier and reviewer: {risks}. Route these and difficult tasks to senior.",
        f"Worker budget: {escalation['workerAttempts']} attempts, then escalate to senior. Senior budget: {escalation['seniorAttempts']} attempts; stop implementation when exhausted and report remaining defects.",
        exhausted,
        "Every verifier and reviewer must be a NEW named xpowers-routing-* agent with fresh context. Never resume the author, reuse the author's thread, or use fork. Give task card, invariants, base/head diff and acceptance criteria, not the author's reasoning transcript.",
        "Worker and reviewer may share a model; they must never share an agent context. Verifier uses a different configured model from worker/senior. Record attempt counts and evidence in an outside-repository scratchpad.",
        "Before dispatch, read .claude/routing.json. Use named xpowers-routing-explorer/worker/verifier/senior/reviewer. Do not override models or delegate to an unlisted agent. Native maxTurns limits each invocation; attempt budgets and risk classification are coordinator workflow obligations.",
        "The coordinator may read source and write external memory/scratch with native file tools. Project edits, arbitrary shell execution and unknown tools are blocked by PreToolUse. Delegate builds, tests, Git mutations and fixes. Do not change routing controls to bypass a denial.",
        "A changed diff invalidates prior verification/review; obtain new evidence. If checks fail or budgets expire, do not accept the change. Verifier and reviewer report defects without fixing the source.",
        "Run /routing-smoke-test. Use /routing-off only at the user's request. Hooks enforce this workflow, not an OS security sandbox; provider availability and actual model routing must be checked in Claude Code /tasks.",
    ])
