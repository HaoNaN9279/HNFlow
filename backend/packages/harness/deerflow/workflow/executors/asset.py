"""Asset workflow executor (N9, dev plan §20).

One node type (``data:asset``) with four operations:

- ``inspect`` — read a file's identity (size / mtime / optional SHA-256) and
  return an :class:`~deerflow.assets.ref.AssetRef`.  Read-only, the primary use
  case, which is why the node type is registered as idempotent.
- ``import`` — copy a **host** file into a sandbox directory.
- ``export`` — copy a **sandbox** file back out to a host directory.
- ``convert`` — run a declared converter (``assets.converters``) over a sandbox
  asset and emit the converted asset.

Boundaries this executor deliberately respects:

- **Host access requires ``assets.roots``.**  An empty ``roots`` list (the
  default) rejects every host path, so an untouched deployment cannot be made to
  read or write arbitrary host files.  Paths are checked three ways: lexical
  containment after normalisation, symlink rejection on the source itself, and a
  resolved-path re-check so a symlinked *parent* cannot smuggle the write out.
- **Commands run in the sandbox** (``Sandbox.execute_command``), exactly like
  ``tool:bash``; the host-side app driver stays the only exception to that rule.
- **``import`` / ``export`` / ``convert`` require ``crash_confirm=true``.**  They
  mutate files, so they carry their own gate internally — the same pattern
  ``data:file`` write mode uses — which keeps the node type out of the
  pending-review "dangerous node" set while still refusing to run unconfirmed.
- **Writes are atomic.**  ``export`` stages a same-directory temporary file and
  ``os.replace``s it, mirroring the artifacts router.
"""

from __future__ import annotations

import asyncio
import logging
import os
import stat
import tempfile
from pathlib import Path, PurePosixPath
from typing import Any, cast

from deerflow.assets.contracts import AssetContractError
from deerflow.assets.ref import (
    SCOPE_VIRTUAL_PREFIXES,
    AssetRef,
    AssetScope,
    asset_ref_from_stat,
    fingerprint_bytes,
    fingerprint_file,
    make_ref,
    ref_from_port,
    validate_asset_against_contract,
)
from deerflow.config.assets_config import AssetsConfig, get_assets_config
from deerflow.sandbox import tools as sandbox_tools
from deerflow.workflow.compiler import WorkflowRuntime
from deerflow.workflow.registry import WorkflowExecutionError

logger = logging.getLogger(__name__)

#: Sandbox directories an asset may be placed into / read from.
SANDBOX_DESTINATIONS: tuple[str, ...] = ("workspace", "uploads", "outputs")

#: Where an imported / converted asset lands when ``params.destination`` is unset.
DEFAULT_SANDBOX_DESTINATION = "workspace"

#: Where a converted asset lands by default (outputs is what ``present_files``
#: and the artifacts API surface to the user).
DEFAULT_CONVERT_DESTINATION = "outputs"

_DETAIL_LIMIT = 400

# ── small helpers ─────────────────────────────────────────────────────────────


def _require_crash_confirm(params: dict[str, Any], node_label: str) -> None:
    if params.get("crash_confirm") is not True:
        raise WorkflowExecutionError(f"{node_label}: requires crash_confirm=true (the operation mutates files)")


def _config() -> AssetsConfig:
    return get_assets_config()


def _sandbox(runtime: WorkflowRuntime) -> Any:
    # Duck-type compatible with ensure_sandbox_initialized (same as data:file).
    return sandbox_tools.ensure_sandbox_initialized(runtime)  # type: ignore[arg-type]


def _truncate(text: str | None, limit: int = _DETAIL_LIMIT) -> str:
    value = (text or "").strip()
    return value if len(value) <= limit else f"{value[:limit]}…"


def _as_posix(path: str) -> str:
    return str(path).replace("\\", "/")


def _hash_file(path: Path) -> str:
    return fingerprint_file(path)


def _shell_quote(value: str) -> str:
    """Quote one argv element for the sandbox shell.

    Paths with spaces are the realistic case; double quotes are the one spelling
    both POSIX shells and PowerShell accept.  Embedded double quotes are dropped
    (Windows filenames cannot contain them, and a POSIX path that does is not
    worth a shell-independent escaping scheme here).
    """
    if value and not any(ch in value for ch in " \t\"'&|;<>()$`\\!^%*?[]{}"):
        return value
    return '"' + value.replace('"', "") + '"'


def _result(ref: AssetRef, *, detail: str | None = None) -> dict[str, Any]:
    payload = ref.to_port()
    outputs: dict[str, Any] = {"out": payload, "asset": payload, "assets": [payload]}
    if detail:
        outputs["detail"] = detail
    return outputs


def _apply_contract(params: dict[str, Any], ref: AssetRef, config: AssetsConfig, node_label: str) -> AssetRef:
    name = params.get("contract")
    if not name:
        return ref
    contract = config.contract_for(str(name))
    if contract is None:
        raise WorkflowExecutionError(f"{node_label}: contract {name!r} is not declared under assets.contracts")
    try:
        return validate_asset_against_contract(ref, contract, name=str(name))
    except AssetContractError as exc:
        detail = f" (expected {exc.expected}, got {exc.actual})" if exc.expected else ""
        raise WorkflowExecutionError(f"{node_label}: {exc}{detail}") from exc


def _source_ref(params: dict[str, Any], inputs: dict[str, Any], *, node_label: str) -> AssetRef:
    """Resolve the source asset from ``params.path`` or the ``in`` port."""
    raw: Any = params.get("path")
    if raw is None or (isinstance(raw, str) and not raw.strip()):
        raw = inputs.get("in")
    if isinstance(raw, (list, tuple)):
        raw = raw[0] if raw else None

    ref: AssetRef | None
    if isinstance(raw, AssetRef):
        ref = raw
    elif isinstance(raw, dict):
        ref = AssetRef.model_validate(raw)
    elif isinstance(raw, str) and raw.strip():
        scope = params.get("scope")
        ref = make_ref(raw.strip(), scope=scope) if scope else ref_from_port(raw.strip())
    else:
        ref = None

    if ref is None:
        raise WorkflowExecutionError(f"{node_label}: missing required param 'path' (or an 'in' port value)")
    return ref


def _require_host_source(path: str, config: AssetsConfig, node_label: str) -> Path:
    """Validate a host source path and return its resolved ``Path``."""
    if not config.host_transfer_enabled:
        raise WorkflowExecutionError(f"{node_label}: host asset transfer is disabled; declare assets.roots to enable it")
    if not config.allows_host_path(path):
        raise WorkflowExecutionError(f"{node_label}: path {path!r} is outside assets.roots")
    try:
        link_stat = os.lstat(path)
    except OSError as exc:
        raise WorkflowExecutionError(f"{node_label}: cannot access {path!r}: {exc}") from exc
    if stat.S_ISLNK(link_stat.st_mode):
        raise WorkflowExecutionError(f"{node_label}: symlinked assets are not transferred ({path!r})")
    if not stat.S_ISREG(link_stat.st_mode):
        raise WorkflowExecutionError(f"{node_label}: not a regular file ({path!r})")
    resolved = Path(path).resolve()
    if not config.allows_host_path(str(resolved)):
        raise WorkflowExecutionError(f"{node_label}: resolved path {str(resolved)!r} escapes assets.roots")
    return resolved


def _require_within_max_bytes(size: int, path: str, config: AssetsConfig, node_label: str) -> None:
    if size > config.max_bytes:
        raise WorkflowExecutionError(f"{node_label}: {path!r} is {size} bytes, above assets.max_bytes={config.max_bytes}")


def _resolve_host_destination(params: dict[str, Any], config: AssetsConfig, *, source_name: str, node_label: str) -> Path:
    """Resolve (and validate) the host target of an ``export``."""
    if not config.host_transfer_enabled:
        raise WorkflowExecutionError(f"{node_label}: host asset transfer is disabled; declare assets.roots to enable it")
    destination = params.get("destination")
    if destination:
        candidate = Path(str(destination))
        target = candidate if candidate.is_absolute() else Path(config.roots[0]) / candidate
    else:
        target = Path(config.roots[0]) / source_name
    if not config.allows_host_path(str(target)):
        raise WorkflowExecutionError(f"{node_label}: destination {str(target)!r} is outside assets.roots")
    parent = target.parent
    if parent.exists() and not config.allows_host_path(str(parent.resolve())):
        raise WorkflowExecutionError(f"{node_label}: destination directory {str(parent)!r} escapes assets.roots")
    return target


def _write_host_atomically(target: Path, data: bytes) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    temp_fd, temp_name = tempfile.mkstemp(prefix=".asset-", dir=str(target.parent))
    temp_path = Path(temp_name)
    try:
        with os.fdopen(temp_fd, "wb") as handle:
            temp_fd = -1
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, target)
    finally:
        if temp_fd >= 0:
            os.close(temp_fd)
        try:
            temp_path.unlink()
        except FileNotFoundError:
            pass


def _resolve_sandbox_destination(params: dict[str, Any], *, source_name: str, default_scope: str, node_label: str) -> tuple[AssetScope, str]:
    """Resolve ``(scope, virtual_path)`` for an asset landing in the sandbox."""
    scope = str(params.get("destination") or default_scope).strip().lower()
    if scope not in SANDBOX_DESTINATIONS:
        raise WorkflowExecutionError(f"{node_label}: destination {scope!r} must be one of {list(SANDBOX_DESTINATIONS)}")
    name = params.get("destination_path") or source_name
    relative = PurePosixPath(str(name)).name if "/" not in str(name) else str(name).lstrip("/")
    if not relative or relative in {".", ".."}:
        raise WorkflowExecutionError(f"{node_label}: invalid destination_path {name!r}")
    sandbox_scope = cast(AssetScope, scope)
    return sandbox_scope, f"{SCOPE_VIRTUAL_PREFIXES[sandbox_scope]}/{relative}"


# ── operations ────────────────────────────────────────────────────────────────


async def _inspect(runtime: WorkflowRuntime, params: dict[str, Any], inputs: dict[str, Any], node_label: str) -> dict[str, Any]:
    config = _config()
    source = _source_ref(params, inputs, node_label=node_label)
    want_hash = params.get("hash") is not False
    source_label = params.get("source")

    if source.scope == "host":
        path = _require_host_source(source.path, config, node_label)
        stat_result = await asyncio.to_thread(path.stat)
        sha256 = await asyncio.to_thread(_hash_file, path) if want_hash else None
        ref = asset_ref_from_stat(str(path), stat_result, scope="host", sha256=sha256, source=source_label or node_label)
    else:
        sandbox = _sandbox(runtime)
        data = await asyncio.to_thread(sandbox.download_file, source.path)
        _require_within_max_bytes(len(data), source.path, config, node_label)
        ref = make_ref(
            source.path,
            scope=source.scope,
            size=len(data),
            sha256=fingerprint_bytes(data) if want_hash else None,
            source=source_label or node_label,
        )

    return _result(_apply_contract(params, ref, config, node_label))


async def _import(runtime: WorkflowRuntime, params: dict[str, Any], inputs: dict[str, Any], node_label: str) -> dict[str, Any]:
    config = _config()
    source = _source_ref(params, inputs, node_label=node_label)
    if source.scope != "host":
        raise WorkflowExecutionError(f"{node_label}: import expects a host path, got scope {source.scope!r}")

    path = _require_host_source(source.path, config, node_label)
    size = (await asyncio.to_thread(path.stat)).st_size
    _require_within_max_bytes(size, str(path), config, node_label)
    data = await asyncio.to_thread(path.read_bytes)

    scope, virtual = _resolve_sandbox_destination(params, source_name=path.name, default_scope=DEFAULT_SANDBOX_DESTINATION, node_label=node_label)
    sandbox = _sandbox(runtime)
    await asyncio.to_thread(sandbox.update_file, virtual, data)

    ref = make_ref(virtual, scope=scope, size=len(data), sha256=fingerprint_bytes(data), source=node_label)
    return _result(_apply_contract(params, ref, config, node_label))


async def _export(runtime: WorkflowRuntime, params: dict[str, Any], inputs: dict[str, Any], node_label: str) -> dict[str, Any]:
    config = _config()
    source = _source_ref(params, inputs, node_label=node_label)
    if source.scope == "host":
        raise WorkflowExecutionError(f"{node_label}: export expects a sandbox path, got a host path")

    sandbox = _sandbox(runtime)
    data = await asyncio.to_thread(sandbox.download_file, source.path)
    _require_within_max_bytes(len(data), source.path, config, node_label)

    target = _resolve_host_destination(params, config, source_name=PurePosixPath(source.path).name, node_label=node_label)
    await asyncio.to_thread(_write_host_atomically, target, data)

    ref = make_ref(str(target), scope="host", size=len(data), sha256=fingerprint_bytes(data), source=node_label)
    return _result(_apply_contract(params, ref, config, node_label))


async def _convert(runtime: WorkflowRuntime, params: dict[str, Any], inputs: dict[str, Any], node_label: str) -> dict[str, Any]:
    config = _config()
    name = params.get("converter")
    converter = config.converter_for(str(name) if name else None)
    if converter is None:
        raise WorkflowExecutionError(f"{node_label}: converter {name!r} is not declared under assets.converters")

    source = _source_ref(params, inputs, node_label=node_label)
    if source.scope == "host":
        raise WorkflowExecutionError(f"{node_label}: convert operates on sandbox assets; import the file first")
    if source.extension != converter.from_extension:
        raise WorkflowExecutionError(f"{node_label}: converter {name!r} expects {converter.from_extension} but the source is {source.extension or '<none>'}")

    scope, target_virtual = _resolve_sandbox_destination(
        params,
        source_name=f"{PurePosixPath(source.path).stem}{converter.to_extension}",
        default_scope=DEFAULT_CONVERT_DESTINATION,
        node_label=node_label,
    )
    sandbox = _sandbox(runtime)
    argv = converter.build_command(source=source.path, target=target_virtual)
    command = " ".join(_shell_quote(arg) for arg in argv)
    thread_data = sandbox_tools.get_thread_data(runtime)  # type: ignore[arg-type]
    command = sandbox_tools.replace_virtual_paths_in_command(command, thread_data)
    output = await asyncio.to_thread(sandbox.execute_command, command, None, converter.timeout_seconds)

    try:
        data = await asyncio.to_thread(sandbox.download_file, target_virtual)
    except OSError as exc:
        raise WorkflowExecutionError(f"{node_label}: converter {name!r} produced no output at {target_virtual} (command output: {_truncate(output)})") from exc
    _require_within_max_bytes(len(data), target_virtual, config, node_label)

    ref = make_ref(target_virtual, scope=scope, size=len(data), sha256=fingerprint_bytes(data), source=str(name))
    return _result(_apply_contract(params, ref, config, node_label), detail=_truncate(output))


# ── entry point ───────────────────────────────────────────────────────────────

_OPERATIONS = {
    "inspect": _inspect,
    "import": _import,
    "export": _export,
    "convert": _convert,
}


async def exec_asset(runtime: WorkflowRuntime, params: dict[str, Any], inputs: dict[str, Any]) -> dict[str, Any]:
    """Execute a ``data:asset`` node.

    ``params.operation`` selects the behaviour (default ``inspect``).
    ``params.path`` (or the ``in`` port) names the source; ``params.contract``
    optionally validates it against a declared contract; ``import`` / ``export``
    / ``convert`` additionally require ``params.crash_confirm is True``.
    """
    operation = str(params.get("operation") or "inspect").strip().lower()
    node_label = f"data:asset ({operation})"
    handler = _OPERATIONS.get(operation)
    if handler is None:
        raise WorkflowExecutionError(f"data:asset: unsupported operation {operation!r}")
    if operation != "inspect":
        _require_crash_confirm(params, node_label)
    return await handler(runtime, params, inputs, node_label)


__all__ = ["DEFAULT_CONVERT_DESTINATION", "DEFAULT_SANDBOX_DESTINATION", "SANDBOX_DESTINATIONS", "exec_asset"]
