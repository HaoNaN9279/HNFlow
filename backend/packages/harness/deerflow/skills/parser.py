import json
import logging
import re as _stdlib_re
from pathlib import Path

import yaml
from pydantic import ValidationError

from deerflow.environment.spec import RequirementSpec

from .contract import CAPABILITY_PERMISSIONS
from .types import SKILL_MD_FILE, DependencySpec, GroupManifest, SecretRequirement, Skill, SkillCategory
from .versions import parse_version

logger = logging.getLogger(__name__)

# Valid POSIX environment-variable name.
_ENV_VAR_NAME_RE = _stdlib_re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def _format_yaml_error(skill_file: Path, exc: yaml.YAMLError, source: str) -> str:
    """Render a developer-friendly explanation of a YAML front-matter error."""

    lines = [f"Invalid YAML front-matter in {skill_file}: {exc}"]

    mark = getattr(exc, "problem_mark", None)
    source_lines = source.splitlines()
    if mark is not None and 0 <= mark.line < len(source_lines):
        offending = source_lines[mark.line]

        # mark.line is 0-based within the front-matter body; +1 makes it
        # 1-based, +1 more accounts for the leading `---` fence that the
        # front-matter regex strips before yaml.safe_load sees it.
        file_line_number = mark.line + 2
        lines.append(f"  line {file_line_number}: {offending}")

        if getattr(exc, "problem", "") == "mapping values are not allowed here" and ":" in offending:
            key, _, value = offending.partition(":")
            value = value.strip()
            if value and value[0] not in {'"', "'", "|", ">", "[", "{"}:
                escaped = value.replace("\\", "\\\\").replace('"', '\\"')
                lines.append(f'  hint: values containing ":" must be quoted, e.g. {key}: "{escaped}"')

    return "\n".join(lines)


def parse_allowed_tools(raw: object, skill_file: Path) -> tuple[str, ...] | None:
    """Parse the optional allowed-tools frontmatter field.

    Returns None when the field is omitted. Returns a tuple when the field is a
    YAML sequence of strings, including an empty tuple for explicit no-tool
    skills. Raises ValueError for malformed values.
    """
    if raw is None:
        return None
    if not isinstance(raw, list):
        raise ValueError(f"allowed-tools in {skill_file} must be a list of strings")

    allowed_tools: list[str] = []
    for item in raw:
        if not isinstance(item, str):
            raise ValueError(f"allowed-tools in {skill_file} must contain only strings")
        tool_name = item.strip()
        if not tool_name:
            raise ValueError(f"allowed-tools in {skill_file} cannot contain empty tool names")
        allowed_tools.append(tool_name)
    return tuple(allowed_tools)


def parse_required_secrets(raw: object, skill_file: Path) -> tuple[SecretRequirement, ...]:
    """Parse the optional required-secrets frontmatter field (issue #3861).

    Accepts a YAML sequence whose items are either a string (the secret / env
    variable name) or a mapping (``{name, optional}``). Returns an empty tuple
    when the field is omitted. Entries whose name is missing or is not a valid
    environment-variable name are dropped with a warning, so one malformed
    declaration does not invalidate the whole skill. Raises ValueError only when
    the field is present but is not a list.
    """
    if raw is None:
        return ()
    if not isinstance(raw, list):
        raise ValueError(f"required-secrets in {skill_file} must be a list")

    secrets: list[SecretRequirement] = []
    seen: set[str] = set()
    for item in raw:
        if isinstance(item, str):
            name, optional = item.strip(), False
        elif isinstance(item, dict):
            name = str(item.get("name") or "").strip()
            optional = bool(item.get("optional", False))
        else:
            logger.warning("Ignoring malformed required-secrets entry in %s: %r", skill_file, item)
            continue

        if not _ENV_VAR_NAME_RE.match(name):
            logger.warning("Ignoring required-secrets entry with invalid env var name in %s: %r", skill_file, name)
            continue
        if name in seen:
            continue
        seen.add(name)
        secrets.append(SecretRequirement(name=name, optional=optional))
    return tuple(secrets)


def parse_secrets_autonomous(raw: object, skill_file: Path) -> bool:
    """Parse the optional ``secrets-autonomous`` frontmatter field (issue #3914).

    ``True`` (the default) lets declared secrets bind while the skill is
    in-context via an autonomous model load; ``False`` restricts binding to
    explicit ``/slash`` activation. A malformed (non-boolean) value fails
    closed to ``False`` — the safer, less-injection direction.
    """
    if raw is None:
        return True
    if isinstance(raw, bool):
        return raw
    logger.warning("Ignoring malformed secrets-autonomous value in %s: %r (autonomous binding disabled)", skill_file, raw)
    return False


def _read_group_manifest(skill_dir: Path) -> GroupManifest | None:
    """Read ``group.json`` from *skill_dir*, returning ``None`` when absent or malformed."""
    group_file = skill_dir / "group.json"
    if not group_file.exists():
        return None
    try:
        raw = group_file.read_text(encoding="utf-8")
        data = json.loads(raw)
    except (json.JSONDecodeError, OSError) as exc:
        logger.warning("Failed to read group.json in %s: %s", skill_dir, exc)
        return None
    try:
        # Normalise JSON list → tuple for the frozen dataclass.
        if isinstance(data.get("aliases"), list):
            data["aliases"] = tuple(data["aliases"])
        return GroupManifest(**data)
    except TypeError as exc:
        logger.warning("Malformed group.json in %s: %s", skill_dir, exc)
        return None


def parse_dependencies(raw: object, skill_file: Path) -> tuple[DependencySpec, ...] | None:
    """Parse the optional ``dependencies`` frontmatter field.

    Each element must be a mapping with ``guid`` (str, 32 hex chars) and
    ``version`` (non-empty str).  Returns ``None`` when the field is omitted.
    Raises ``ValueError`` for malformed values.
    """
    if raw is None:
        return None
    if not isinstance(raw, list):
        raise ValueError(f"dependencies in {skill_file} must be a list")

    deps: list[DependencySpec] = []
    for i, item in enumerate(raw):
        if not isinstance(item, dict):
            raise ValueError(f"dependencies[{i}] in {skill_file} must be a mapping")
        guid = item.get("guid")
        version = item.get("version")
        if not isinstance(guid, str) or len(guid) != 32:
            raise ValueError(f"dependencies[{i}].guid in {skill_file} must be a 32-character hex string")
        try:
            int(guid, 16)
        except ValueError:
            raise ValueError(f"dependencies[{i}].guid in {skill_file} must be a valid hex string")
        if not isinstance(version, str) or not version.strip():
            raise ValueError(f"dependencies[{i}].version in {skill_file} must be a non-empty string")
        deps.append(DependencySpec(guid=guid, version=version.strip()))
    return tuple(deps)


def parse_requirements(raw: object, skill_file: Path) -> tuple[RequirementSpec, ...]:
    """Parse the optional ``requires`` frontmatter field (N11, plan §22).

    A capability group can only run where the software it drives exists, so a
    skill package declares what it needs in the same shape an application
    definition does (``deerflow.environment.spec.RequirementSpec``).  The field is
    a list of mappings::

        requires:
          - { kind: version, name: blender, command: [blender, "--version"], expect: ">=4.0" }
          - { kind: plugin, name: "addons/my-addon", optional: true }

    Malformed entries are dropped with a warning instead of failing the whole
    skill, mirroring :func:`parse_required_secrets`: a typo in an optional
    declaration must not make an otherwise-installable package unloadable, and the
    report still shows what was actually declared.  A missing field yields ``()``.
    """
    if raw is None:
        return ()
    if not isinstance(raw, list):
        logger.warning("Ignoring non-list requires in %s: %r", skill_file, raw)
        return ()

    requirements: list[RequirementSpec] = []
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            logger.warning("Ignoring requires[%d] in %s: not a mapping", index, skill_file)
            continue
        try:
            requirements.append(RequirementSpec.model_validate(item))
        except ValidationError as exc:
            logger.warning("Ignoring malformed requires[%d] in %s: %s", index, skill_file, exc)
    return tuple(requirements)


def parse_permissions(raw: object, skill_file: Path) -> tuple[str, ...]:
    """Parse the optional ``permissions`` frontmatter field (N14 §5.5).

    A list drawn from {``fs``, ``net``, ``exec``, ``secrets``}.  Unknown entries
    are dropped with a warning (a typo in an optional declaration must not make
    the package unloadable), and a non-list value is ignored entirely.  A missing
    field yields ``()``.
    """
    if raw is None:
        return ()
    if not isinstance(raw, list):
        logger.warning("Ignoring non-list permissions in %s: %r", skill_file, raw)
        return ()
    permissions: list[str] = []
    for item in raw:
        name = str(item).strip().lower()
        if name not in CAPABILITY_PERMISSIONS:
            logger.warning("Ignoring unknown permission %r in %s; allowed: %s", item, skill_file, sorted(CAPABILITY_PERMISSIONS))
            continue
        if name not in permissions:
            permissions.append(name)
    return tuple(permissions)


def parse_extends(raw: object, skill_file: Path) -> tuple[str, ...]:
    """Parse the optional ``extends`` frontmatter field (N14 §5.5).

    A capability group name or a list of them: the packages this one builds on.
    Names are trimmed and deduplicated.  A malformed entry, or a non-string /
    non-list value, **raises** — unlike a cosmetic optional field, dropping it
    would load the package without the tools it declared it inherits, which is
    the one failure mode a capability declaration must never have (the caller
    mirrors ``dependencies``: a broken declaration makes the file unloadable).
    """
    if raw is None:
        return ()
    values = raw if isinstance(raw, list) else [raw]
    extends: list[str] = []
    for item in values:
        if not isinstance(item, str) or not item.strip():
            raise ValueError(f"extends in {skill_file} must be a capability group name or a list of them, got {item!r}")
        name = item.strip()
        if name not in extends:
            extends.append(name)
    return tuple(extends)


def parse_overlay(raw: object, skill_file: Path) -> bool:
    """Parse the optional ``overlay`` frontmatter field (N14 §5.5).

    ``True`` means the package's own ``allowed-tools`` **replace** the inherited
    list instead of adding to it. Only a real boolean is accepted, and anything
    else **raises**: reading ``"true"`` as truthy would quietly turn an additive
    declaration into a narrowing one, and reading it as false would quietly
    widen the tool set beyond what the author wrote.
    """
    if raw is None:
        return False
    if not isinstance(raw, bool):
        raise ValueError(f"overlay in {skill_file} must be a boolean, got {raw!r}")
    return raw


def parse_tool_schema_version(raw: object, skill_file: Path) -> str | None:
    """Parse the optional ``tool-schema-version`` frontmatter field (N14 §5.5)."""
    if raw is None:
        return None
    text = str(raw).strip()
    if not text:
        logger.warning("Ignoring empty tool-schema-version in %s", skill_file)
        return None
    return text


def parse_context_budget(raw: object, skill_file: Path) -> int | None:
    """Parse the optional ``context-budget`` frontmatter field (N14 §5.5)."""
    if raw is None:
        return None
    if isinstance(raw, bool):
        logger.warning("Ignoring non-integer context-budget in %s: %r", skill_file, raw)
        return None
    try:
        value = int(raw)
    except (TypeError, ValueError):
        logger.warning("Ignoring non-integer context-budget in %s: %r", skill_file, raw)
        return None
    if value <= 0:
        logger.warning("Ignoring non-positive context-budget in %s: %r", skill_file, raw)
        return None
    return value


def parse_skill_file(skill_file: Path, category: SkillCategory, relative_path: Path | None = None) -> Skill | None:
    """Parse a SKILL.md file and extract metadata.

    Args:
        skill_file: Path to the SKILL.md file.
        category: Category of the skill.
        relative_path: Relative path from the category root to the skill
            directory.  Defaults to the skill directory name when omitted.

    Returns:
        Skill object if parsing succeeds, None otherwise.
    """
    if not skill_file.exists() or skill_file.name != SKILL_MD_FILE:
        return None

    try:
        content = skill_file.read_text(encoding="utf-8")

        # Keep parser diagnostics richer than the pure helper's host-path-free
        # error string; tests and authoring UX depend on the line-specific hint.
        front_matter_match = _stdlib_re.match(r"^---\s*\n(.*?)\n---\s*\n?", content, _stdlib_re.DOTALL)
        if not front_matter_match:
            return None
        front_matter_text = front_matter_match.group(1)
        try:
            metadata = yaml.safe_load(front_matter_text)
        except yaml.YAMLError as exc:
            logger.error("%s", _format_yaml_error(skill_file, exc, front_matter_text))
            return None
        if not isinstance(metadata, dict):
            logger.error("Invalid SKILL.md front-matter in %s: Frontmatter must be a YAML dictionary", skill_file)
            return None

        # Extract required fields.  Both must be non-empty strings.
        name = metadata.get("name")
        description = metadata.get("description")

        if not name or not isinstance(name, str):
            return None
        if not description or not isinstance(description, str):
            return None

        # Normalise: strip surrounding whitespace that YAML may preserve.
        name = name.strip()
        description = description.strip()

        if not name or not description:
            return None

        license_text = metadata.get("license")
        if license_text is not None:
            license_text = str(license_text).strip() or None

        try:
            allowed_tools = parse_allowed_tools(metadata.get("allowed-tools"), skill_file)
        except ValueError as exc:
            logger.error("Invalid allowed-tools in %s: %s", skill_file, exc)
            return None

        try:
            required_secrets = parse_required_secrets(metadata.get("required-secrets"), skill_file)
        except ValueError as exc:
            logger.error("Invalid required-secrets in %s: %s", skill_file, exc)
            return None

        secrets_autonomous = parse_secrets_autonomous(metadata.get("secrets-autonomous"), skill_file)

        # --- version (T7) ---
        version_raw = metadata.get("version")
        if version_raw is not None:
            try:
                version = parse_version(str(version_raw))
            except ValueError as exc:
                logger.error("Invalid version in %s: %s", skill_file, exc)
                return None
        else:
            version = "0.1.0"  # Legacy skill — no version field.

        # --- compatibility (T7 / T8) ---
        compat_raw = metadata.get("compatibility")
        if compat_raw is None:
            compatibility = None
        elif isinstance(compat_raw, str):
            compatibility = compat_raw.strip() or None
        else:
            logger.warning("Non-string compatibility value in %s: %r (ignored)", skill_file, compat_raw)
            compatibility = None

        # --- group manifest (T8) ---
        manifest = _read_group_manifest(skill_file.parent)
        skill_id = manifest.guid if manifest is not None else None

        # --- dependencies (T8) ---
        try:
            dependencies = parse_dependencies(metadata.get("dependencies"), skill_file)
        except ValueError as exc:
            logger.error("Invalid dependencies in %s: %s", skill_file, exc)
            return None

        # --- environment requirements (N11) ---
        requirements = parse_requirements(metadata.get("requires"), skill_file)

        # --- capability contract (N14 §5.5) ---
        permissions = parse_permissions(metadata.get("permissions"), skill_file)
        tool_schema_version = parse_tool_schema_version(metadata.get("tool-schema-version"), skill_file)
        context_budget = parse_context_budget(metadata.get("context-budget"), skill_file)
        # --- composition (N14 §5.5) ---
        # A malformed composition declaration makes the file unloadable, exactly
        # like ``dependencies``: loading it without the inheritance would ship a
        # package with fewer (or wider) capabilities than its author declared.
        try:
            extends = parse_extends(metadata.get("extends"), skill_file)
            overlay = parse_overlay(metadata.get("overlay"), skill_file)
        except ValueError as exc:
            logger.error("Invalid composition declaration in %s: %s", skill_file, exc)
            return None

        return Skill(
            name=name,
            description=description,
            license=license_text,
            skill_dir=skill_file.parent,
            skill_file=skill_file,
            relative_path=relative_path or Path(skill_file.parent.name),
            category=category,
            allowed_tools=allowed_tools,
            enabled=True,  # Actual state comes from the extensions config file.
            required_secrets=required_secrets,
            secrets_autonomous=secrets_autonomous,
            version=version,
            compatibility=compatibility,
            skill_id=skill_id,
            dependencies=dependencies,
            requirements=requirements,
            permissions=permissions,
            tool_schema_version=tool_schema_version,
            context_budget=context_budget,
            extends=extends,
            overlay=overlay,
        )

    except Exception:
        logger.exception("Unexpected error parsing skill file %s", skill_file)
        return None
