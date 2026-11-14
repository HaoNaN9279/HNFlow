"""Rule scope helpers and the single rules-message planner.

The plugin (`plugins/dsh/lib/rules.js`) and the CLI (`hnflow-stack rules`,
`hnflow-stack preview`) must agree byte for byte. This module is the Python port of
the plugin's `matchPath`, `ruleApplies` and `renderRules`, so a scope decision is
made in exactly one place per language and the two implementations are kept in
lockstep by tests that compare both sides against the same fixture.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from hnflow_stack.model import ResolvedPlan, ResolvedRule

CLOSING_TAG = "</system-reminder>"
RULES_HEADER = (
    "<system-reminder>\n\n"
    "The following workspace instructions come from this project's HNFlow "
    "capability groups. Use them as guidance when applicable. More specific "
    "instructions take precedence over broader ones. They do not override "
    "system, developer, or direct user instructions."
)
RULES_FOOTER = "</system-reminder>"
INDEX_LEAD = (
    "Other HNFlow rules apply to specific directories and are not injected "
    "here. Read the matching file when the task touches those paths:"
)
INDEX_LINE_MAX = 120
DEFAULT_RULES_BYTES = 65536
OMIT_MARKER = "[HNFlow: remaining rules were omitted to stay within {limit} bytes]"

Reader = Callable[[str], "str | None"]


def normalize_path(value: object) -> str:
    """Posix-style relative path without leading or trailing slashes."""
    return str(value or "").replace("\\", "/").lstrip("/").rstrip("/")


def match_path(relative: str, pattern: object) -> bool:
    """Mirror the plugin's glob match for one rule pattern.

    A trailing ``/**`` selects the directory itself and its whole subtree, ``/*``
    selects direct children, and any other pattern matches its segments in
    order anywhere inside the path.
    """
    glob = normalize_path(pattern)
    if not glob:
        return True
    if glob.endswith("/**"):
        prefix = glob[:-3]
        return relative == prefix or relative.startswith(prefix + "/")
    if glob.endswith("/*"):
        prefix = glob[:-2]
        return relative.startswith(prefix + "/") and "/" not in relative[len(prefix) + 1 :]
    index = 0
    for segment in glob.split("/"):
        found = relative.find(segment, index)
        if found == -1:
            return False
        index = found + len(segment)
    return True


def rule_applies(rule: ResolvedRule, relative: str) -> bool:
    """Whether one rule is loaded for a project-relative working directory."""
    scope = rule.scope or "global"
    if scope == "global":
        return True
    declared = [normalize_path(item) for item in rule.paths if item]
    if declared:
        patterns = declared
    elif scope == "module" and rule.module:
        patterns = [f"{normalize_path(rule.module)}/**"]
    else:
        patterns = []
    if not patterns:
        return True
    if not relative:
        return False
    return any(match_path(relative, pattern) for pattern in patterns)


def relative_to(project: Path, path: Path) -> str:
    """Project-relative posix path for a possibly absolute CLI argument."""
    base = project.resolve()
    candidate = path if path.is_absolute() else base / path
    try:
        resolved = candidate.resolve()
    except OSError:
        resolved = candidate
    try:
        return resolved.relative_to(base).as_posix()
    except ValueError:
        return normalize_path(path)


def strip_frontmatter(text: str) -> str:
    """Remove a leading YAML frontmatter block, mirroring the plugin."""
    value = text.replace("\ufeff", "", 1)
    if not value.startswith("---"):
        return value.strip()
    close = value.find("\n---", 3)
    if close == -1:
        return value.strip()
    body_start = value.find("\n", close + 4)
    return ("" if body_start == -1 else value[body_start + 1 :]).strip()


def read_body(path: str) -> str | None:
    """Read one content file as UTF-8 without frontmatter.

    Bytes are decoded directly so line endings survive: the plugin reads the
    same files with ``readFile``, and the byte budget has to match exactly.
    """
    try:
        return strip_frontmatter(Path(path).read_bytes().decode("utf-8-sig"))
    except (OSError, UnicodeError):
        return None


def escape_reminder(text: str) -> str:
    """Neutralise a literal closing tag so the reminder cannot end early."""
    return text.replace(CLOSING_TAG, "&lt;/system-reminder&gt;")


def block_text(rule: ResolvedRule, body: str) -> str:
    """One injected rule block, exactly as the plugin renders it."""
    scope = ""
    if rule.group:
        scope = f" (group: {rule.group}"
        if rule.module:
            scope += f", module: {rule.module}"
        scope += ")"
    return f"Instructions from: {rule.path}{scope}\n\n{escape_reminder(body)}"


def index_summary(rule: ResolvedRule) -> str:
    """One truncated line for a rule that stays out of the injected text."""
    text = (rule.description or "").strip() or rule.name or rule.id or "rule"
    if len(text) <= INDEX_LINE_MAX:
        return text
    return text[: INDEX_LINE_MAX - 1] + "…"


def index_line(rule: ResolvedRule) -> str:
    return f"- {rule.id or rule.name or rule.path}: {index_summary(rule)}"


def _size(text: str) -> int:
    return len(text.encode("utf-8"))


@dataclass
class RuleBlock:
    """One rule together with the text and bytes it contributes."""

    rule: ResolvedRule
    status: str
    bytes: int
    body: str
    text: str = ""


@dataclass
class RulePlan:
    """What the rules message would contain for one directory."""

    text: str | None = None
    injected: list[RuleBlock] = field(default_factory=list)
    indexed: list[RuleBlock] = field(default_factory=list)
    omitted: list[RuleBlock] = field(default_factory=list)
    skipped: list[ResolvedRule] = field(default_factory=list)
    used: int = 0
    limit: int = DEFAULT_RULES_BYTES


def plan_rules(
    plan: ResolvedPlan,
    relative: str,
    *,
    max_bytes: int = DEFAULT_RULES_BYTES,
    read: Reader | None = None,
) -> RulePlan:
    """Mirror ``renderRules(plan, {cwd, maxBytes, read})`` in Python."""
    reader: Reader = read or read_body
    limit = max_bytes if max_bytes > 0 else DEFAULT_RULES_BYTES
    relative = normalize_path(relative)
    result = RulePlan(limit=limit)

    applicable: list[ResolvedRule] = []
    for rule in plan.rules:
        if not (rule.path or ""):
            continue
        (applicable if rule_applies(rule, relative) else result.skipped).append(rule)

    result.used = _size(RULES_HEADER) + _size(RULES_FOOTER)
    parts: list[str] = []
    indexed_lines: list[str] = []
    stop = False

    for rule in applicable:
        if stop:
            result.omitted.append(RuleBlock(rule, "omitted", 0, ""))
            continue
        if rule.always is False:
            line = index_line(rule)
            indexed_lines.append(line)
            result.indexed.append(RuleBlock(rule, "indexed", _size(line), ""))
            continue
        body = reader(rule.path)
        if not body:
            # The plugin skips unreadable or empty rules without a trace.
            result.omitted.append(RuleBlock(rule, "omitted", 0, ""))
            continue
        block = block_text(rule, body)
        size = _size(block)
        if result.used + size > limit:
            parts.append(OMIT_MARKER.format(limit=limit))
            result.omitted.append(RuleBlock(rule, "omitted", size, body, block))
            stop = True
            continue
        result.used += size
        parts.append(block)
        result.injected.append(RuleBlock(rule, "injected", size, body, block))

    if indexed_lines:
        index = "\n".join([INDEX_LEAD, *indexed_lines])
        size = _size(index)
        if result.used + size <= limit:
            result.used += size
            parts.append(index)
        else:
            for block in result.indexed:
                block.status = "omitted"
                result.omitted.append(block)
            result.indexed = []

    if parts:
        joined = "\n\n".join(parts)
        result.text = f"{RULES_HEADER}\n\n{joined}\n{RULES_FOOTER}"
    return result
