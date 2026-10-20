"""Unified tool references for capability groups.

Capability groups reference tools through stable ids::

    tool:<guid>@v<version>   custom package
    mcp:<server>:<tool>      MCP tool
    builtin:<name>           builtin/config tool
    sandbox:<name>           sandbox tool
    app:<name>               local-application tool

The registry resolves those references through the concrete tool gateway.  It
never silently drops an explicitly declared tool: a missing server, package, or
provider tool raises :class:`ToolResolutionError`.
"""

from __future__ import annotations

import copy
import importlib.util
import logging
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

from deerflow.skills.permission_policy import adjudicate, required_permissions
from deerflow.tools.mcp_metadata import get_mcp_origin
from deerflow.tools.packages import ToolPackage, ToolPackageError, discover_tool_packages, load_tool_package

if TYPE_CHECKING:
    from langchain_core.tools import BaseTool

logger = logging.getLogger(__name__)

_TOOL_REF_PREFIXES = ("tool:", "mcp:", "builtin:", "sandbox:", "app:")


class ToolResolutionError(ValueError):
    """A declared tool reference cannot be resolved or is not permitted."""


@dataclass(frozen=True)
class ToolBinding:
    """One resolved tool reference."""

    ref: str
    provider: str
    name: str
    tool: BaseTool
    permissions: tuple[str, ...] = ()
    permissions_declared: bool = False
    package: ToolPackage | None = None


def _split_ref(ref: str) -> tuple[str, str]:
    if not isinstance(ref, str) or not ref.strip():
        raise ToolResolutionError("tool reference must be a non-empty string")
    value = ref.strip()
    for prefix in _TOOL_REF_PREFIXES:
        if value.startswith(prefix):
            return prefix[:-1], value[len(prefix) :]
    raise ToolResolutionError(f"unsupported tool reference {ref!r}; expected one of {', '.join(_TOOL_REF_PREFIXES)}")


def _parse_package_ref(value: str) -> tuple[str, str | None]:
    identifier, separator, version = value.rpartition("@v")
    if not separator:
        return value, None
    if not identifier or not version:
        raise ToolResolutionError(f"invalid tool package reference {value!r}; expected <guid>@v<version>")
    return identifier, version


class ToolRegistry:
    """Resolve capability-group tool references through a tool gateway."""

    def __init__(self, gateway: Any, *, package_root: Path | None = None) -> None:
        self._gateway = gateway
        self._package_root = package_root
        self._mcp_index = self._build_mcp_index()
        self._package_cache: dict[str, ToolPackage] = {}

    def _build_mcp_index(self) -> dict[str, BaseTool]:
        index: dict[str, BaseTool] = {}
        for provider in getattr(self._gateway, "providers", ()):
            if getattr(provider, "name", None) != "mcp":
                continue
            for name, tool in getattr(provider, "tools", {}).items():
                origin = get_mcp_origin(tool)
                if origin is None:
                    continue
                server, original_name = origin
                index[f"mcp:{server}:{original_name}"] = tool
                # Accept the model-visible name as an alias.  The canonical
                # reference remains server + original tool name.
                index.setdefault(f"mcp:{server}:{name}", tool)
        return index

    def _package(self, identifier: str, version: str | None) -> ToolPackage:
        cache_key = f"{identifier}@v{version}" if version else identifier
        cached = self._package_cache.get(cache_key)
        if cached is not None:
            return cached
        try:
            package = load_tool_package(identifier, version=version, root=self._package_root)
        except ToolPackageError as exc:
            raise ToolResolutionError(str(exc)) from exc
        self._package_cache[cache_key] = package
        return package

    def _load_python_tool(self, package: ToolPackage) -> BaseTool:
        from langchain_core.tools import BaseTool

        entrypoint = package.entrypoint or ""
        relative, separator, attribute = entrypoint.partition(":")
        if not separator or not relative or not attribute:
            raise ToolResolutionError(f"tool package {package.ref}: entrypoint must be '<file>:<attribute>'")
        source = (package.root / relative).resolve()
        if not source.is_relative_to(package.root):
            raise ToolResolutionError(f"tool package {package.ref}: entrypoint escapes the package root")
        if not source.is_file():
            raise ToolResolutionError(f"tool package {package.ref}: entrypoint file {relative!r} not found")

        module_name = f"_deerflow_tool_{package.guid}_{package.version.replace('.', '_')}"
        spec = importlib.util.spec_from_file_location(module_name, source)
        if spec is None or spec.loader is None:
            raise ToolResolutionError(f"tool package {package.ref}: cannot load {relative!r}")
        module = importlib.util.module_from_spec(spec)
        sys.modules[module_name] = module
        try:
            spec.loader.exec_module(module)
        except Exception as exc:  # noqa: BLE001 - report the author's error verbatim
            raise ToolResolutionError(f"tool package {package.ref}: failed to import {relative!r}: {exc}") from exc

        obj = getattr(module, attribute, None)
        if isinstance(obj, BaseTool):
            tool = obj
        elif callable(obj):
            try:
                produced = obj()
            except Exception as exc:  # noqa: BLE001 - report the author's error verbatim
                raise ToolResolutionError(f"tool package {package.ref}: factory {entrypoint!r} failed: {exc}") from exc
            if not isinstance(produced, BaseTool):
                raise ToolResolutionError(f"tool package {package.ref}: {entrypoint!r} must return a BaseTool")
            tool = produced
        else:
            raise ToolResolutionError(f"tool package {package.ref}: {entrypoint!r} is not a BaseTool or factory")
        return tool

    def _package_tool(self, package: ToolPackage) -> BaseTool:
        if package.provider == "python":
            tool = self._load_python_tool(package)
        elif package.provider == "mcp":
            ref = f"mcp:{package.server}:{package.tool}"
            tool = self._resolve_mcp(ref)
        elif package.provider in {"builtin", "sandbox"}:
            tool = self._resolve_provider(package.provider, package.tool or "")
        elif package.provider == "app":
            tool = self._resolve_app(package.app or package.tool or "")
        else:  # pragma: no cover - manifest validation rejects this
            raise ToolResolutionError(f"tool package {package.ref}: unsupported provider {package.provider!r}")

        if package.model_name and tool.name != package.model_name:
            tool = copy.copy(tool)
            tool.name = package.model_name  # type: ignore[attr-defined]
        return tool

    def _resolve_provider(self, provider: str, name: str) -> BaseTool:
        if not name:
            raise ToolResolutionError(f"{provider} tool reference requires a tool name")
        tool = self._gateway.resolve(name, provider=provider)
        if tool is None:
            raise ToolResolutionError(f"{provider} tool {name!r} is not available")
        return tool

    def _resolve_app(self, name: str) -> BaseTool:
        for candidate in (f"app_{name}", name):
            tool = self._gateway.resolve(candidate, provider="app")
            if tool is not None:
                return tool
        raise ToolResolutionError(f"app tool {name!r} is not available")

    def _resolve_mcp(self, ref: str) -> BaseTool:
        tool = self._mcp_index.get(ref)
        if tool is None:
            raise ToolResolutionError(f"MCP tool {ref!r} is not available (is the server enabled and the tool discovered?)")
        return tool

    def resolve_ref(self, ref: str) -> ToolBinding:
        """Resolve one canonical reference into a concrete tool binding."""
        kind, value = _split_ref(ref)
        if kind == "tool":
            identifier, version = _parse_package_ref(value)
            package = self._package(identifier, version)
            tool = self._package_tool(package)
            return ToolBinding(
                ref=ref,
                provider=package.provider,
                name=tool.name,
                tool=tool,
                permissions=package.permissions,
                permissions_declared=package.permissions_declared,
                package=package,
            )
        if kind == "mcp":
            server, separator, tool_name = value.partition(":")
            if not separator or not server or not tool_name:
                raise ToolResolutionError(f"invalid MCP tool reference {ref!r}; expected mcp:<server>:<tool>")
            tool = self._resolve_mcp(f"mcp:{server}:{tool_name}")
            return ToolBinding(ref=ref, provider="mcp", name=tool.name, tool=tool)
        if kind == "app":
            # ``app:<app>:<tool>`` is accepted for readability; the current app
            # provider exposes one callable per application, named app_<app>.
            app_name = value.split(":", 1)[0]
            tool = self._resolve_app(app_name)
            return ToolBinding(ref=ref, provider="app", name=tool.name, tool=tool)
        tool = self._resolve_provider(kind, value)
        return ToolBinding(ref=ref, provider=kind, name=tool.name, tool=tool)

    def descriptors(self) -> list[dict[str, Any]]:
        """Return the catalog of addressable tools (no package import executed)."""
        entries: dict[str, dict[str, Any]] = {}
        for package in discover_tool_packages(root=self._package_root):
            entries[package.ref] = {
                "id": package.ref,
                "name": package.model_name or package.name,
                "provider": package.provider,
                "description": package.description,
                "permissions": list(package.permissions),
                "source": "package",
                "version": package.version,
            }

        for provider in getattr(self._gateway, "providers", ()):
            provider_name = getattr(provider, "name", "")
            for name, tool in getattr(provider, "tools", {}).items():
                if provider_name == "mcp":
                    origin = get_mcp_origin(tool)
                    if origin is None:
                        continue
                    server, original_name = origin
                    ref = f"mcp:{server}:{original_name}"
                elif provider_name == "app":
                    if not name.startswith("app_"):
                        continue
                    ref = f"app:{name[len('app_') :]}"
                else:
                    ref = f"{provider_name}:{name}"
                if ref in entries:
                    continue
                required = required_permissions(name, provider=provider_name)
                entries[ref] = {
                    "id": ref,
                    "name": name,
                    "provider": provider_name,
                    "description": getattr(tool, "description", None),
                    "permissions": sorted(required) if required is not None else None,
                    "source": "provider",
                    "version": None,
                }
        return sorted(entries.values(), key=lambda item: str(item["id"]))

    def resolve(
        self,
        refs: list[str],
        *,
        permissions: tuple[str, ...] = (),
        overrides: dict[str, tuple[str, ...]] | None = None,
    ) -> list[BaseTool]:
        """Resolve references in order, deduplicating and enforcing permissions."""
        seen_refs: set[str] = set()
        seen_names: dict[str, str] = {}
        resolved: list[BaseTool] = []
        declared = tuple(permission.strip().lower() for permission in permissions if permission and permission.strip())
        declared_set = set(declared)
        override_map = {ref: tuple(value) for ref, value in (overrides or {}).items()}

        for ref in refs:
            canonical = ref.strip()
            if canonical in seen_refs:
                continue
            seen_refs.add(canonical)
            binding = self.resolve_ref(canonical)

            # A per-tool override or an explicit manifest declaration is
            # authoritative even when empty ([] means "no permission needed").
            # Only tools with no declaration fall back to the name table.
            if canonical in override_map:
                required: tuple[str, ...] | None = override_map[canonical]
            elif binding.permissions_declared:
                required = binding.permissions
            else:
                required = None

            if declared_set and required is not None:
                missing = set(required) - declared_set
                if missing:
                    raise ToolResolutionError(f"tool {canonical!r} needs {sorted(missing)} but the capability group declares only {sorted(declared_set)}")
            elif declared_set:
                decision = adjudicate(declared_set, binding.name, provider=binding.provider)
                if not decision.allowed:
                    raise ToolResolutionError(decision.reason)

            previous = seen_names.get(binding.name)
            if previous is not None and previous != canonical:
                raise ToolResolutionError(f"tool name {binding.name!r} is declared by both {previous!r} and {canonical!r}")
            seen_names[binding.name] = canonical
            resolved.append(binding.tool)
        return resolved


__all__ = [
    "ToolBinding",
    "ToolRegistry",
    "ToolResolutionError",
    "required_permissions",
]
