"""Workflow tool gateway (minimal) — unified descriptors + provider dispatch (N1).

Every tool an ``ai:llm_agent`` node may call is resolved through this gateway:
the node's capability groups contribute an allowed-tools union, and the gateway
maps each tool name to a concrete ``BaseTool`` via per-provider resolution.

Design notes (dev plan §9):

- The gateway normalizes *descriptors* and *dispatch*, it does **not** hide
  execution heterogeneity: a sandbox command, a local builtin, and a remote MCP
  tool remain different things.  Providers are registered in priority order and
  the first one that can resolve a name wins.
- This is the deliberate *minimal* slice: builtin + sandbox providers only.
  MCP / skill-script / app providers are additive follow-ups (P1) and register
  here without changing the node executor.
- Resolution is order-stable (sorted tool ids) so the model-visible tool list —
  and therefore the prompt prefix — is deterministic (cache friendly, §5.9).

The module is dependency-light: heavy tool/config imports happen inside
:func:`build_default_tool_gateway`, not at module import time, so the workflow
package import graph stays free of the agent tool graph.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Protocol

if TYPE_CHECKING:
    from langchain.tools import BaseTool

logger = logging.getLogger(__name__)

#: Provider category labels for a resolved tool.
PROVIDER_BUILTIN = "builtin"
PROVIDER_SANDBOX = "sandbox"
PROVIDER_APP = "app"


@dataclass(frozen=True)
class ToolDescriptor:
    """Normalized identity of one tool, independent of its provider."""

    id: str
    provider: str
    description: str | None = None
    idempotent: bool = True


class ToolProvider(Protocol):
    """A source of tools the gateway can dispatch to."""

    name: str

    def resolve(self, tool_id: str) -> BaseTool | None:  # pragma: no cover - protocol
        ...

    def descriptors(self) -> list[ToolDescriptor]:  # pragma: no cover - protocol
        ...


@dataclass
class StaticToolProvider:
    """A provider backed by an in-memory ``name → BaseTool`` mapping."""

    name: str
    tools: dict[str, BaseTool] = field(default_factory=dict)

    def resolve(self, tool_id: str) -> BaseTool | None:
        return self.tools.get(tool_id)

    def descriptors(self) -> list[ToolDescriptor]:
        return [ToolDescriptor(id=name, provider=self.name, description=getattr(tool, "description", None)) for name, tool in sorted(self.tools.items())]


class ToolGateway:
    """Priority-ordered tool resolution across registered providers."""

    def __init__(self, providers: list[ToolProvider] | None = None) -> None:
        self._providers: list[ToolProvider] = list(providers or [])

    def add_provider(self, provider: ToolProvider) -> None:
        self._providers.append(provider)

    @property
    def providers(self) -> list[ToolProvider]:
        return list(self._providers)

    def resolve(self, tool_id: str) -> BaseTool | None:
        """Resolve one tool id to a ``BaseTool``; first provider wins."""
        for provider in self._providers:
            tool = provider.resolve(tool_id)
            if tool is not None:
                return tool
        return None

    def resolve_all(self, tool_ids: list[str]) -> list[BaseTool]:
        """Resolve many ids, preserving order and skipping unresolved names."""
        resolved: list[BaseTool] = []
        for tool_id in tool_ids:
            tool = self.resolve(tool_id)
            if tool is None:
                logger.warning("Tool gateway: tool %r could not be resolved by any provider", tool_id)
                continue
            resolved.append(tool)
        return resolved

    def descriptors(self) -> list[ToolDescriptor]:
        """Union of every provider's descriptors (id is unique across providers)."""
        seen: set[str] = set()
        out: list[ToolDescriptor] = []
        for provider in self._providers:
            for descriptor in provider.descriptors():
                if descriptor.id in seen:
                    continue
                seen.add(descriptor.id)
                out.append(descriptor)
        return out


def _sandbox_tools() -> dict[str, BaseTool]:
    """The built-in sandbox file/command tools by their model-visible name."""
    from deerflow.sandbox import tools as sandbox_tools

    candidates = (
        sandbox_tools.bash_tool,
        sandbox_tools.ls_tool,
        sandbox_tools.glob_tool,
        sandbox_tools.grep_tool,
        sandbox_tools.read_file_tool,
        sandbox_tools.write_file_tool,
        sandbox_tools.str_replace_tool,
    )
    return {getattr(t, "name", ""): t for t in candidates if getattr(t, "name", "")}


def _builtin_tools(*, model_name: str | None, app_config: Any) -> dict[str, BaseTool]:
    """Config-defined + built-in + MCP tools assembled by the tool system."""
    from deerflow.tools.tools import get_available_tools

    available = get_available_tools(
        model_name=model_name,
        include_mcp=True,
        subagent_enabled=False,
        include_upload_tool=False,
        app_config=app_config,
    )
    return {getattr(t, "name", ""): t for t in available if getattr(t, "name", "")}


def _app_tools(*, app_config: Any) -> dict[str, BaseTool]:
    """One tool per *available* registered local application (N5).

    Each tool runs one script command against the application's shared session
    manager (launch/attach → run → collect), returning stdout and artifact
    paths as JSON.  Unavailable applications (driver cannot construct, command
    missing) are skipped so the tool list stays truthful — fail-open per app.
    """
    from langchain_core.tools import StructuredTool
    from pydantic import BaseModel, Field

    from deerflow.apps.registry import AppRegistry
    from deerflow.config.apps_config import AppsConfig, get_apps_config

    if isinstance(app_config, AppsConfig):
        apps_config = app_config
    else:
        nested = getattr(app_config, "apps", None)
        apps_config = nested if isinstance(nested, AppsConfig) else get_apps_config()
    registry = AppRegistry.from_config(apps_config)

    class AppRunInput(BaseModel):
        script: str = Field(default="", description="Script command to run in the application (may be empty).")
        args: list[str] = Field(default_factory=list, description="Extra script arguments.")

    def _make_runner(app_name: str):
        async def _run(script: str = "", args: list[str] | None = None) -> str:
            import asyncio
            import json

            from deerflow.apps.session import get_session_manager

            manager = get_session_manager()
            session = await asyncio.to_thread(manager.launch, app_name)
            result = await asyncio.to_thread(manager.run_script, session, script=script or None, args=list(args or []))
            artifacts = await asyncio.to_thread(manager.collect, session)
            return json.dumps(
                {
                    "app": app_name,
                    "session_id": session.session_id,
                    "status": result.status,
                    "exit_code": result.exit_code,
                    "stdout": result.stdout,
                    "stderr": result.stderr,
                    "artifacts": artifacts,
                },
                ensure_ascii=False,
            )

        return _run

    tools: dict[str, BaseTool] = {}
    for name, definition in registry.entries():
        try:
            if not registry.build_driver(name).available(definition):
                continue
        except Exception as e:  # noqa: BLE001 - fail-open per app
            logger.warning("Tool gateway: app %r driver unavailable: %s", name, e)
            continue
        tool_name = f"app_{name}"
        tools[tool_name] = StructuredTool.from_function(
            coroutine=_make_runner(name),
            name=tool_name,
            description=f"Run a script command in the local application '{name}'. {definition.description}".strip(),
            args_schema=AppRunInput,
        )
    return tools


def build_default_tool_gateway(*, model_name: str | None = None, app_config: Any = None) -> ToolGateway:
    """Build the gateway with the minimal builtin + sandbox (+ app) providers.

    Fail-open per provider: a provider that cannot be constructed (missing
    config, import error) is skipped with a warning rather than failing the
    node.  Sandbox is registered first so a name present in both sets prefers
    the sandbox command/file tool; the app provider is registered last so a
    sandbox/builtin tool name always wins a collision.
    """
    gateway = ToolGateway()

    try:
        gateway.add_provider(StaticToolProvider(PROVIDER_SANDBOX, _sandbox_tools()))
    except Exception as e:  # noqa: BLE001 - fail-open provider
        logger.warning("Tool gateway: sandbox provider unavailable: %s", e)

    try:
        gateway.add_provider(StaticToolProvider(PROVIDER_BUILTIN, _builtin_tools(model_name=model_name, app_config=app_config)))
    except Exception as e:  # noqa: BLE001 - fail-open provider
        logger.warning("Tool gateway: builtin provider unavailable: %s", e)

    try:
        gateway.add_provider(StaticToolProvider(PROVIDER_APP, _app_tools(app_config=app_config)))
    except Exception as e:  # noqa: BLE001 - fail-open provider
        logger.warning("Tool gateway: app provider unavailable: %s", e)

    return gateway


def _load_enabled_skills(user_id: str | None) -> list[Any]:
    """Load enabled skills for the user, fail-open to an empty list."""
    try:
        from deerflow.skills.storage import get_or_new_user_skill_storage

        storage = get_or_new_user_skill_storage(user_id) if user_id is not None else None
        if storage is None:
            from deerflow.skills.storage import get_or_new_skill_storage

            storage = get_or_new_skill_storage()
        return list(storage.load_skills(enabled_only=True))
    except Exception as e:  # noqa: BLE001 - fail-open by design
        logger.warning("Tool gateway: failed to load skills for capability groups: %s", e)
        return []


def resolve_capability_tools(
    capability_groups: list[str],
    *,
    user_id: str | None = None,
    model_name: str | None = None,
    app_config: Any = None,
) -> list[BaseTool]:
    """Resolve an AI node's tool set from its capability groups (C1).

    The tool set is the **union of the selected groups' ``allowed-tools``
    declarations**, resolved through the gateway.  A node with no capability
    groups — or whose groups declare no ``allowed-tools`` — gets no tools,
    matching the "an AI node can only call capabilities its groups declare"
    boundary (§7.1).  Tool order is sorted by name for prompt-cache stability
    (§5.9).
    """
    if not capability_groups:
        return []

    selected_names = set(capability_groups)
    skills = [skill for skill in _load_enabled_skills(user_id) if getattr(skill, "name", None) in selected_names]

    # Reuse the shared skill-policy union helper (None = legacy allow-all,
    # returned only when no selected skill declares allowed-tools).
    from deerflow.skills.tool_policy import allowed_tool_names_for_skills

    allowed = allowed_tool_names_for_skills(skills)
    if not allowed:
        logger.info(
            "AI node capability groups %s declare no allowed-tools; node gets no tools",
            sorted(selected_names),
        )
        return []

    gateway = build_default_tool_gateway(model_name=model_name, app_config=app_config)
    return gateway.resolve_all(sorted(allowed))


__all__ = [
    "ToolDescriptor",
    "ToolProvider",
    "StaticToolProvider",
    "ToolGateway",
    "build_default_tool_gateway",
    "resolve_capability_tools",
    "PROVIDER_BUILTIN",
    "PROVIDER_SANDBOX",
    "PROVIDER_APP",
]
