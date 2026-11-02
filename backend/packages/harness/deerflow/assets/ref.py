"""Asset references (N9, dev plan §20) — one identity for files that cross the
host ↔ sandbox boundary.

The engine has two filesystem worlds: workflow data nodes read and write
*sandbox* virtual paths (``/mnt/user-data/{workspace,uploads,outputs}/…``),
while local-application drivers produce *host* absolute paths.  Nothing in the
workflow state tied those together before N9, so an ``app:collect`` result could
not feed a later ``data:file`` node and a sandbox artifact could not be handed
back to the local software.

:class:`AssetRef` is that shared identity: a small, JSON-serialisable value
carrying a canonical ``asset://`` URI, the scope-local path, and a fingerprint
(``size`` / ``mtime`` / optional ``sha256``).  It travels on a ``data``-typed
port (no new ``PortType``, following the N5 session-port precedent).

Everything here is pure — no filesystem access, no environment reads — so the
same helpers run for host-side (``app:collect``) and sandbox-side
(``data:asset``) producers, and command templates can be unit-tested without a
sandbox.  Callers that do have a ``stat`` result use
:func:`asset_ref_from_stat`; callers that only have bytes use
:func:`fingerprint_bytes`.
"""

from __future__ import annotations

import hashlib
import os
from typing import Any, Literal, cast

from pydantic import BaseModel, ConfigDict, Field

from deerflow.assets.contracts import AssetContract, AssetContractError

#: Where an asset physically lives.
AssetScope = Literal["host", "workspace", "uploads", "outputs"]

#: Canonical URI scheme for asset references.
ASSET_SCHEME = "asset"

#: Virtual path prefixes the sandbox exposes for each non-host scope.
SCOPE_VIRTUAL_PREFIXES: dict[str, str] = {
    "workspace": "/mnt/user-data/workspace",
    "uploads": "/mnt/user-data/uploads",
    "outputs": "/mnt/user-data/outputs",
}

_SANDBOX_SCOPES: tuple[str, ...] = ("workspace", "uploads", "outputs")

#: Default read size for :func:`fingerprint_file`.
_HASH_CHUNK_BYTES = 1024 * 1024

#: Small, stable extension → media type table.  Deliberately static (no
#: ``mimetypes``) so asset refs are identical on every platform and never read
#: the Windows registry.
_MEDIA_TYPES: dict[str, str] = {
    ".abc": "application/x-alembic",
    ".ai": "application/postscript",
    ".avi": "video/x-msvideo",
    ".blend": "application/x-blender",
    ".csv": "text/csv",
    ".exr": "image/x-exr",
    ".fbx": "application/octet-stream",
    ".flac": "audio/flac",
    ".gif": "image/gif",
    ".glb": "model/gltf-binary",
    ".gltf": "model/gltf+json",
    ".hdri": "image/vnd.radiance",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".json": "application/json",
    ".md": "text/markdown",
    ".mkv": "video/x-matroska",
    ".mov": "video/quicktime",
    ".mp3": "audio/mpeg",
    ".mp4": "video/mp4",
    ".obj": "model/obj",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".psb": "image/vnd.adobe.photoshop",
    ".psd": "image/vnd.adobe.photoshop",
    ".stl": "model/stl",
    ".tga": "image/x-tga",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
    ".txt": "text/plain",
    ".unity": "application/octet-stream",
    ".usd": "model/vnd.usd",
    ".usda": "model/vnd.usda",
    ".usdc": "model/vnd.usdc",
    ".usdz": "model/vnd.usdz+zip",
    ".wav": "audio/wav",
    ".webm": "video/webm",
    ".zip": "application/zip",
}


# ── path / extension helpers ──────────────────────────────────────────────────


def _as_posix(path: str) -> str:
    return str(path).replace("\\", "/")


def normalize_host_path(path: str) -> str:
    """Return *path* as a normalised absolute host path (no filesystem access)."""
    expanded = os.path.expanduser(str(path))
    return os.path.normpath(os.path.abspath(expanded))


def extension_of(path: str) -> str | None:
    """Return the lowercase dot-prefixed extension of *path*, or ``None``.

    A dotfile (``.bashrc``) has no extension; ``a/b.TAR.GZ`` → ``.gz``.
    """
    name = _as_posix(path).rsplit("/", 1)[-1]
    index = name.rfind(".")
    if index <= 0 or index == len(name) - 1:
        return None
    return name[index:].lower()


def media_type_for(extension: str | None) -> str | None:
    """Return the built-in media type for *extension* (``None`` when unknown)."""
    if not extension:
        return None
    return _MEDIA_TYPES.get(extension.lower())


def scope_for_virtual_path(path: str) -> str | None:
    """Return the sandbox scope owning *path*, or ``None`` when it is not a
    recognised virtual path."""
    candidate = _as_posix(path)
    for scope, prefix in SCOPE_VIRTUAL_PREFIXES.items():
        if candidate == prefix or candidate.startswith(f"{prefix}/"):
            return scope
    return None


def _virtual_path(scope: str, path: str) -> str:
    """Normalise *path* into the sandbox-virtual absolute form for *scope*."""
    prefix = SCOPE_VIRTUAL_PREFIXES[scope]
    candidate = _as_posix(path)
    if candidate == prefix or candidate.startswith(f"{prefix}/"):
        remainder = candidate[len(prefix) :].lstrip("/")
    else:
        remainder = candidate.lstrip("/")
    if not remainder:
        return prefix
    return f"{prefix}/{remainder}"


# ── URIs ──────────────────────────────────────────────────────────────────────


def asset_uri(scope: AssetScope, path: str) -> str:
    """Build the canonical ``asset://`` URI for *scope* + *path*.

    Host paths are normalised to an absolute, forward-slash form
    (``asset://host/C:/models/chair.fbx``); sandbox paths are stored relative to
    their scope root (``asset://workspace/scenes/chair.blend``).
    """
    if scope == "host":
        return f"{ASSET_SCHEME}://host/{_as_posix(normalize_host_path(path))}"
    prefix = SCOPE_VIRTUAL_PREFIXES.get(scope)
    if prefix is None:
        raise ValueError(f"unknown asset scope {scope!r}")
    virtual = _virtual_path(scope, path)
    remainder = virtual[len(prefix) :].lstrip("/")
    return f"{ASSET_SCHEME}://{scope}/{remainder}" if remainder else f"{ASSET_SCHEME}://{scope}"


def parse_asset_uri(uri: str) -> tuple[AssetScope, str]:
    """Inverse of :func:`asset_uri`.

    Returns ``(scope, path)`` where sandbox paths are virtual-absolute
    (``/mnt/user-data/workspace/…``) and host paths are platform-normalised
    absolute paths.

    Raises:
        ValueError: on a malformed URI, an unknown scheme or scope, or a path
            escaping its scope root.
    """
    text = str(uri).strip()
    prefix = f"{ASSET_SCHEME}://"
    if not text.startswith(prefix):
        raise ValueError(f"not an asset URI: {uri!r}")
    remainder = text[len(prefix) :]
    scope, _, raw_path = remainder.partition("/")
    scope = scope.lower()
    if scope == "host":
        if not raw_path:
            raise ValueError(f"asset URI is missing a host path: {uri!r}")
        return "host", normalize_host_path(raw_path)
    if scope not in SCOPE_VIRTUAL_PREFIXES:
        raise ValueError(f"unknown asset scope {scope!r} in {uri!r}")
    if raw_path.startswith("/") or ".." in raw_path.split("/"):
        raise ValueError(f"asset URI escapes its scope root: {uri!r}")
    sandbox_scope = cast(AssetScope, scope)
    return sandbox_scope, _virtual_path(sandbox_scope, raw_path)


# ── fingerprints ──────────────────────────────────────────────────────────────


def fingerprint_bytes(data: bytes) -> str:
    """Return the SHA-256 hex digest of *data*."""
    return hashlib.sha256(data).hexdigest()


def fingerprint_file(path: str | os.PathLike[str], *, chunk_size: int = _HASH_CHUNK_BYTES) -> str:
    """Return the SHA-256 hex digest of a file, read in bounded chunks.

    The one I/O helper in this module (everything else is pure): callers with a
    filesystem offload it to a worker thread, and streaming keeps a multi-GB
    render from being materialised in memory just to be hashed.
    """
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(chunk_size), b""):
            digest.update(chunk)
    return digest.hexdigest()


# ── the reference itself ──────────────────────────────────────────────────────


class AssetRef(BaseModel):
    """A first-class reference to a file that workflow nodes can pass around.

    ``path`` is always usable as-is by the node that consumes it: a sandbox
    virtual path for ``workspace`` / ``uploads`` / ``outputs``, an absolute host
    path for ``host``.  ``sha256`` is optional and only populated when a caller
    asked for (or needed) full hashing — a multi-GB render should not be hashed
    just to name it.
    """

    model_config = ConfigDict(extra="forbid")

    uri: str = Field(description="Canonical asset:// URI.")
    path: str = Field(description="Scope-local usable path (virtual for sandbox scopes, absolute for host).")
    scope: AssetScope = Field(description="Which filesystem world this asset lives in.")
    size: int | None = Field(default=None, ge=0, description="File size in bytes, when known.")
    sha256: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$", description="SHA-256 hex digest, when computed.")
    mtime: float | None = Field(default=None, description="Modification time (POSIX seconds), when known.")
    extension: str | None = Field(default=None, description="Lowercase dot-prefixed extension.")
    media_type: str | None = Field(default=None, description="Media type derived from the extension or supplied by a driver.")
    contract: str | None = Field(default=None, description="Name of the assets.contracts entry this asset was validated against.")
    source: str | None = Field(default=None, description="Producer of the reference (app name, node id, converter name).")

    def to_port(self) -> dict[str, Any]:
        """Return the JSON-safe dict carried on a ``data`` port."""
        return self.model_dump()

    def is_sandbox(self) -> bool:
        return self.scope in _SANDBOX_SCOPES


def make_ref(
    path: str,
    *,
    scope: AssetScope | None = None,
    size: int | None = None,
    sha256: str | None = None,
    mtime: float | None = None,
    media_type: str | None = None,
    contract: str | None = None,
    source: str | None = None,
) -> AssetRef:
    """Build an :class:`AssetRef`, inferring ``scope`` / ``extension`` / ``media_type``.

    ``scope`` is inferred from a ``/mnt/user-data/<scope>/…`` virtual path,
    otherwise the path is treated as a host path.  Nothing touches the
    filesystem: a ref may name a file that does not exist yet.
    """
    resolved_scope: AssetScope
    if scope is None:
        inferred = scope_for_virtual_path(path)
        resolved_scope = inferred if inferred is not None else "host"  # type: ignore[assignment]
    else:
        resolved_scope = scope

    if resolved_scope == "host":
        normalized = normalize_host_path(path)
    else:
        normalized = _virtual_path(resolved_scope, path)

    extension = extension_of(normalized)
    return AssetRef(
        uri=asset_uri(resolved_scope, normalized),
        path=normalized,
        scope=resolved_scope,
        size=size,
        sha256=sha256,
        mtime=mtime,
        extension=extension,
        media_type=media_type if media_type is not None else media_type_for(extension),
        contract=contract,
        source=source,
    )


def asset_ref_from_stat(
    path: str,
    stat_result: os.stat_result,
    *,
    scope: AssetScope | None = None,
    sha256: str | None = None,
    media_type: str | None = None,
    contract: str | None = None,
    source: str | None = None,
) -> AssetRef:
    """Build an :class:`AssetRef` from an existing ``os.stat`` result.

    Keeps all ``os.stat`` calls in the caller (so they can be offloaded to a
    thread, and so this function stays pure).
    """
    return make_ref(
        path,
        scope=scope,
        size=int(stat_result.st_size),
        sha256=sha256,
        mtime=float(stat_result.st_mtime),
        media_type=media_type,
        contract=contract,
        source=source,
    )


def ref_from_port(value: Any) -> AssetRef | None:
    """Coerce a port value into an :class:`AssetRef`.

    Accepts a ref dict (round-trip), an existing :class:`AssetRef`, or a bare
    path string (``asset://…`` URI, ``/mnt/user-data/…`` virtual path, or a host
    path).  Returns ``None`` for ``None``/empty input.
    """
    if value is None:
        return None
    if isinstance(value, AssetRef):
        return value
    if isinstance(value, dict):
        return AssetRef.model_validate(value)
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        if text.startswith(f"{ASSET_SCHEME}://"):
            scope, path = parse_asset_uri(text)
            return make_ref(path, scope=scope)
        return make_ref(text)
    raise TypeError(f"cannot interpret {type(value).__name__} as an AssetRef")


def refs_from_port(value: Any) -> list[AssetRef]:
    """Coerce a port value into a list of :class:`AssetRef`.

    Accepts a single ref / path, or a list of either.  Empty entries are
    skipped.
    """
    if value is None:
        return []
    if isinstance(value, (list, tuple)):
        refs: list[AssetRef] = []
        for item in value:
            ref = ref_from_port(item)
            if ref is not None:
                refs.append(ref)
        return refs
    ref = ref_from_port(value)
    return [ref] if ref is not None else []


def validate_asset_against_contract(ref: AssetRef, contract: AssetContract, *, name: str | None = None) -> AssetRef:
    """Validate *ref* against *contract* and return a copy carrying ``name``.

    Raises:
        AssetContractError: when the extension or media type does not match,
            with ``expected`` / ``actual`` populated for the error message.
    """
    label = name or contract.description or "contract"
    if not contract.accepts_extension(ref.extension):
        raise AssetContractError(
            f"asset {ref.path!r} does not satisfy contract {label!r}: extension {ref.extension or '<none>'} is not accepted",
            contract=name,
            expected=contract.describe(),
            actual=ref.extension or "<none>",
        )
    if contract.media_type and ref.media_type and ref.media_type != contract.media_type:
        raise AssetContractError(
            f"asset {ref.path!r} does not satisfy contract {label!r}: media type {ref.media_type} does not match",
            contract=name,
            expected=contract.media_type,
            actual=ref.media_type,
        )
    return ref.model_copy(update={"contract": name or ref.contract})


__all__ = [
    "ASSET_SCHEME",
    "SCOPE_VIRTUAL_PREFIXES",
    "AssetRef",
    "AssetScope",
    "asset_ref_from_stat",
    "asset_uri",
    "extension_of",
    "fingerprint_bytes",
    "fingerprint_file",
    "make_ref",
    "media_type_for",
    "normalize_host_path",
    "parse_asset_uri",
    "ref_from_port",
    "refs_from_port",
    "scope_for_virtual_path",
    "validate_asset_against_contract",
]
