"""Load project-scoped content from ``<project>/.hnflow``.

The loader is deliberately independent of the workflow runtime: prompt
assembly, prompt preview, the read-only API and run snapshots all call it, so
every path sees exactly the same project layer.

Trust model (mirrors the capability-group layer):

* instruction/rule/skill files are prompt content — read-only text, framed as
  data, capped by size;
* project tool packages are code references; ``provider: python`` packages
  execute in the Gateway process and therefore require the manifest's explicit
  ``capability.allow_python_tools`` switch;
* a project skill may only shadow a same-named capability skill when the
  manifest sets ``capability.skill_shadow: allow``.  The default is fail-loud.
"""

from __future__ import annotations

import hashlib
import logging
import re
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any

from deerflow.capability_groups.contents import build_capability_contents
from deerflow.project_content.model import (
    DEFAULT_CONTENT_ROOT,
    INSTRUCTION_NAMES,
    MAX_INSTRUCTION_BYTES,
    ProjectContent,
    ProjectInstruction,
    ProjectRule,
    ProjectSkill,
    ProjectToolRef,
)
from deerflow.skills.frontmatter import split_skill_markdown

logger = logging.getLogger(__name__)

_TOOL_REF_RE = re.compile(r"^(?P<provider>tool|mcp|builtin|sandbox|app):(?P<value>.+)$")
_DRIVE_RE = re.compile(r"^[A-Za-z]:")


class ProjectContentError(ValueError):
    """The project's content layer is invalid or unreadable."""


@dataclass(frozen=True)
class _CapabilitySettings:
    """Manifest-derived settings, decoupled from the Pydantic model."""

    enabled: bool = True
    content_root: str = DEFAULT_CONTENT_ROOT
    instructions: tuple[str, ...] = ()
    tools: tuple[str, ...] = ()
    skill_shadow: str = "deny"
    allow_python_tools: bool = False


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _settings(manifest: Any | None) -> _CapabilitySettings:
    raw = getattr(manifest, "capability", None) if manifest is not None else None
    if raw is None:
        return _CapabilitySettings()
    shadow = str(getattr(raw, "skill_shadow", "deny") or "deny")
    return _CapabilitySettings(
        enabled=bool(getattr(raw, "enabled", True)),
        content_root=str(getattr(raw, "content_root", DEFAULT_CONTENT_ROOT) or DEFAULT_CONTENT_ROOT),
        instructions=tuple(str(item) for item in (getattr(raw, "instructions", ()) or ())),
        tools=tuple(str(item) for item in (getattr(raw, "tools", ()) or ())),
        skill_shadow=shadow if shadow in {"deny", "allow"} else "deny",
        allow_python_tools=bool(getattr(raw, "allow_python_tools", False)),
    )


def _normalized_relative(value: str) -> str | None:
    """Return a safe project-relative POSIX path, or ``None`` when unusable."""
    raw = str(value or "").strip().replace("\\", "/")
    if not raw or raw.startswith("/") or _DRIVE_RE.match(raw):
        return None
    pure = PurePosixPath(raw)
    if any(part in {"", ".", ".."} for part in pure.parts):
        return None
    return pure.as_posix()


def _inside_project(root: Path, candidate: Path) -> Path | None:
    """Resolve *candidate* and return it only when it stays inside *root*."""
    try:
        resolved_root = root.resolve()
        resolved = candidate.resolve(strict=False)
    except OSError:
        return None
    if not resolved.is_relative_to(resolved_root):
        return None
    return resolved


def resolve_content_root(root: Path, configured: str | None = None) -> Path | None:
    """Resolve the manifest's content root without creating it."""
    raw = configured if configured is not None else DEFAULT_CONTENT_ROOT
    relative = _normalized_relative(raw)
    if relative is None:
        raise ProjectContentError(f"project content_root must be a project-relative path; got {raw!r}")
    target = _inside_project(root, root / relative)
    if target is None:
        raise ProjectContentError(f"project content_root escapes the project root: {relative}")
    return target


def _manifest_roots(root: Path, manifest: Any | None) -> list[str]:
    if manifest is None:
        return []
    paths: list[str] = []
    for item in getattr(manifest, "roots", ()) or ():
        raw = getattr(item, "path", None)
        if not isinstance(raw, str):
            continue
        normalized = _normalized_relative(raw)
        if normalized is None or normalized == ".":
            continue
        paths.append(normalized)
    return paths


def discover_instructions(
    root: Path,
    manifest: Any | None,
    *,
    settings: _CapabilitySettings | None = None,
) -> tuple[list[ProjectInstruction], list[str]]:
    """Discover the project's instruction documents in broad-to-specific order.

    Order: ``AGENTS.md`` → ``AGENTS.local.md`` at the project root, then the
    same pair under every declared project root, then the manifest's explicit
    ``capability.instructions`` entries.  Nothing outside those locations is
    scanned: an implicit recursive walk would make prompt content depend on
    unrelated repository layout.
    """
    resolved_settings = settings or _settings(manifest)
    warnings: list[str] = []
    candidates: list[tuple[str, str, bool]] = []
    for name in INSTRUCTION_NAMES:
        layer = "project" if name == "AGENTS.md" else "local"
        candidates.append((name, layer, False))
    for base in _manifest_roots(root, manifest):
        for name in INSTRUCTION_NAMES:
            layer = "root" if name == "AGENTS.md" else "root-local"
            candidates.append((f"{base}/{name}", layer, False))
    for entry in resolved_settings.instructions:
        normalized = _normalized_relative(entry)
        if normalized is None:
            warnings.append(f"ignoring invalid capability.instructions entry {entry!r}")
            continue
        candidates.append((normalized, "explicit", True))

    seen: set[Path] = set()
    instructions: list[ProjectInstruction] = []
    for relative, layer, explicit in candidates:
        target = _inside_project(root, root / relative)
        if target is None:
            warnings.append(f"ignoring instruction file outside the project root: {relative}")
            continue
        if target in seen:
            continue
        seen.add(target)
        if not target.is_file():
            if explicit:
                warnings.append(f"instruction file does not exist: {relative}")
            continue
        try:
            size = target.stat().st_size
        except OSError as exc:
            warnings.append(f"cannot stat instruction file {relative}: {exc}")
            continue
        if size > MAX_INSTRUCTION_BYTES:
            warnings.append(f"instruction file {relative} is {size} bytes; max {MAX_INSTRUCTION_BYTES} — skipped")
            continue
        try:
            content = target.read_text(encoding="utf-8", errors="replace")
        except OSError as exc:
            warnings.append(f"cannot read instruction file {relative}: {exc}")
            continue
        if not content.strip():
            continue
        instructions.append(ProjectInstruction(path=relative, content=content, layer=layer))
    return instructions, warnings


def _load_rules(content_root: Path, warnings: list[str]) -> tuple[ProjectRule, ...]:
    rules: list[ProjectRule] = []
    for item in build_capability_contents(content_root):
        if item.category != "rules" or not item.is_markdown:
            continue
        path = content_root / item.path
        try:
            content = path.read_text(encoding="utf-8", errors="replace")
        except OSError as exc:
            warnings.append(f"cannot read project rule {item.path}: {exc}")
            continue
        rules.append(ProjectRule(path=item.path, content=content))
    return tuple(rules)


def _load_skills(content_root: Path, warnings: list[str]) -> tuple[ProjectSkill, ...]:
    skills: dict[str, ProjectSkill] = {}
    order: list[str] = []
    for item in build_capability_contents(content_root):
        if item.category != "skills" or item.name != "SKILL.md" or not item.is_markdown:
            continue
        skill_file = content_root / item.path
        try:
            content = skill_file.read_text(encoding="utf-8", errors="replace")
        except OSError as exc:
            warnings.append(f"cannot read project skill {item.path}: {exc}")
            continue
        parts, error = split_skill_markdown(content)
        if parts is None:
            warnings.append(f"skipping project skill without valid frontmatter: {item.path} ({error})")
            continue
        name = parts.metadata.get("name")
        description = parts.metadata.get("description")
        if not isinstance(name, str) or not name.strip():
            warnings.append(f"skipping project skill with no name: {item.path}")
            continue
        if not isinstance(description, str) or not description.strip():
            warnings.append(f"skipping project skill with no description: {item.path}")
            continue
        normalized_name = name.strip()
        if normalized_name in skills:
            raise ProjectContentError(f"duplicate project skill name {normalized_name!r} in {skills[normalized_name].path} and {item.path}")
        skills[normalized_name] = ProjectSkill(
            name=normalized_name,
            description=description.strip(),
            path=item.path,
            skill_dir=skill_file.parent,
            skill_file=skill_file,
        )
        order.append(normalized_name)
    return tuple(skills[name] for name in order)


def _parse_tool_ref(ref: str) -> tuple[str, str] | None:
    match = _TOOL_REF_RE.match(ref.strip())
    if match is None:
        return None
    return match.group("provider"), match.group("value")


def _describe_tool_ref(ref: str, tool_root: Path | None, warnings: list[str]) -> ProjectToolRef:
    parsed = _parse_tool_ref(ref)
    if parsed is None:
        warnings.append(f"ignoring unsupported project tool reference {ref!r}")
        return ProjectToolRef(ref=ref, error="unsupported reference")
    provider, value = parsed
    if provider != "tool":
        return ProjectToolRef(ref=ref.strip(), provider=provider, name=value)
    if tool_root is None:
        return ProjectToolRef(ref=ref.strip(), provider="tool", error="project content root is not available")

    from deerflow.tools.packages import ToolPackageError, load_tool_package

    identifier, separator, version = value.rpartition("@v")
    if not separator:
        identifier, version = value, None
    try:
        package = load_tool_package(identifier, version=version, root=tool_root)
    except ToolPackageError as exc:
        warnings.append(f"project tool package {ref!r} is not available: {exc}")
        return ProjectToolRef(ref=ref.strip(), provider="tool", error=str(exc))
    return ProjectToolRef(
        ref=package.ref,
        provider=package.provider,
        name=package.model_name or package.name,
        version=package.version,
        path=str(package.root),
    )


def load_project_content(
    root: Path,
    manifest: Any | None = None,
    *,
    content_root: Path | None = None,
) -> ProjectContent:
    """Load the project's instructions, rules, skills and tool references."""
    project_root = Path(root).expanduser().resolve(strict=False)
    if not project_root.is_dir():
        raise ProjectContentError(f"project root does not exist: {project_root}")
    if manifest is None:
        try:
            from deerflow.projects.store import read_manifest

            manifest = read_manifest(project_root)
        except Exception:  # noqa: BLE001 - an unregistered directory has no manifest
            manifest = None

    settings = _settings(manifest)
    if not settings.enabled:
        return ProjectContent(root=project_root, skill_shadow="deny", allow_python_tools=False)

    warnings: list[str] = []
    instructions, instruction_warnings = discover_instructions(project_root, manifest, settings=settings)
    warnings.extend(instruction_warnings)

    resolved_root: Path | None = None
    if content_root is not None:
        resolved_root = _inside_project(project_root, content_root)
        if resolved_root is None:
            raise ProjectContentError(f"project content root escapes the project root: {content_root}")
    else:
        resolved_root = resolve_content_root(project_root, settings.content_root)
    if resolved_root is not None and not resolved_root.is_dir():
        resolved_root = None

    rules = _load_rules(resolved_root, warnings) if resolved_root is not None else ()
    skills = _load_skills(resolved_root, warnings) if resolved_root is not None else ()
    tool_root = (resolved_root / "tools") if resolved_root is not None else None
    tools = tuple(_describe_tool_ref(ref, tool_root, warnings) for ref in settings.tools)
    tool_refs = tuple(dict.fromkeys(ref for ref in settings.tools if ref.strip()))

    return ProjectContent(
        root=project_root,
        content_root=resolved_root,
        instructions=tuple(instructions),
        rules=rules,
        skills=skills,
        tools=tools,
        tool_root=tool_root,
        tool_refs=tool_refs,
        skill_shadow=settings.skill_shadow,
        allow_python_tools=settings.allow_python_tools,
        warnings=tuple(warnings),
    )


def _snapshot_path(path: Path, project_root: Path) -> str:
    try:
        return path.resolve().relative_to(project_root.resolve()).as_posix()
    except (OSError, ValueError):
        return path.as_posix()


def _hash_text(text: str) -> str:
    return _sha256(text)


def _hash_tree(path: Path, project_root: Path) -> list[tuple[str, str]]:
    entries: list[tuple[str, str]] = []
    try:
        files = sorted(item for item in path.rglob("*") if item.is_file())
    except OSError:
        return entries
    for item in files:
        relative = _snapshot_path(item, project_root)
        if "__pycache__" in item.parts or relative.startswith(".git/") or relative.endswith(".pyc"):
            continue
        try:
            digest = hashlib.sha256(item.read_bytes()).hexdigest()
        except OSError:
            continue
        entries.append((relative, digest))
    return entries


def content_snapshot(content: ProjectContent) -> list[dict[str, str]]:
    """Return the project content's stable, path-addressed hash list."""
    entries: list[tuple[str, str]] = []
    for item in content.instructions:
        entries.append((item.path, _hash_text(item.content)))
    for item in content.rules:
        entries.append((item.path, _hash_text(item.content)))
    for item in content.skills:
        try:
            entries.append((item.path, _hash_text(item.skill_file.read_text(encoding="utf-8", errors="replace"))))
        except OSError:
            entries.append((item.path, ""))
    for item in content.tools:
        if item.path:
            entries.extend(_hash_tree(Path(item.path), content.root))
    return [{"path": path, "sha256": digest} for path, digest in sorted(dict(entries).items())]


def content_fingerprint(snapshot: Iterable[dict[str, Any]]) -> str:
    digest = hashlib.sha256()
    digest.update(b"hnflow-project-content-v1\0")
    for item in sorted((entry for entry in snapshot if isinstance(entry, dict)), key=lambda entry: str(entry.get("path") or "")):
        digest.update(str(item.get("path") or "").encode("utf-8"))
        digest.update(b"\0")
        digest.update(str(item.get("sha256") or "").encode("utf-8"))
        digest.update(b"\0")
    return digest.hexdigest()


def verify_project_content_snapshot(content: ProjectContent, snapshot: Sequence[dict[str, Any]]) -> None:
    """Reject a run whose project content changed after admission."""
    expected = {str(item.get("path") or ""): str(item.get("sha256") or "") for item in snapshot if isinstance(item, dict)}
    if not expected:
        return
    actual = {entry["path"]: entry["sha256"] for entry in content_snapshot(content)}
    if expected == actual:
        return
    changed = sorted(path for path in expected if path in actual and expected[path] != actual[path])
    missing = sorted(path for path in expected if path not in actual)
    added = sorted(path for path in actual if path not in expected)
    parts = []
    if changed:
        parts.append(f"changed: {', '.join(changed[:5])}")
    if missing:
        parts.append(f"removed: {', '.join(missing[:5])}")
    if added:
        parts.append(f"added: {', '.join(added[:5])}")
    raise ProjectContentError("project content changed after the run started (" + "; ".join(parts) + ")")


def merge_project_skills(
    capability_skills: Sequence[Any],
    project_skills: Sequence[ProjectSkill],
    *,
    shadow: str = "deny",
) -> tuple[list[Any], tuple[str, ...]]:
    """Merge project skills into the capability skill list, applying shadow policy."""
    merged = list(capability_skills)
    by_name = {skill.name: skill for skill in capability_skills}
    shadowed: list[str] = []
    for skill in project_skills:
        existing = by_name.get(skill.name)
        if existing is None:
            merged.append(skill)
            by_name[skill.name] = skill
            continue
        if shadow != "allow":
            origin = getattr(existing, "group_name", "capability group")
            version = getattr(existing, "group_version", "")
            label = f"{origin}@{version}" if version else str(origin)
            raise ProjectContentError(f'project skill {skill.name!r} shadows skill from {label}; set capability.skill_shadow to "allow" to override')
        index = next(index for index, item in enumerate(merged) if item.name == skill.name)
        merged[index] = skill
        by_name[skill.name] = skill
        shadowed.append(skill.name)
    return merged, tuple(shadowed)


__all__ = [
    "ProjectContentError",
    "content_fingerprint",
    "content_snapshot",
    "discover_instructions",
    "load_project_content",
    "merge_project_skills",
    "resolve_content_root",
    "verify_project_content_snapshot",
]
