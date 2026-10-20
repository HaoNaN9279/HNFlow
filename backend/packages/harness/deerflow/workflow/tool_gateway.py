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
#: MCP tools (N1 §9: MCP is *a provider*, not part of the builtin pool).
PROVIDER_MCP = "mcp"


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

    def resolve(self, tool_id: str, *, provider: str | None = None) -> BaseTool | None:
        """Resolve one tool id to a ``BaseTool``; first provider wins.

        ``provider`` restricts the search to that provider name (the §25
        ``tool:invoke`` node's disambiguator when the same id exists in more
        than one provider).  An unknown provider name resolves nothing rather
        than silently falling back — a typo must not pick a different tool.
        """
        for candidate in self._providers:
            if provider is not None and candidate.name != provider:
                continue
            tool = candidate.resolve(tool_id)
            if tool is not None:
                return tool
        return None

    def provider_names(self) -> list[str]:
        """Registered provider names, in priority order."""
        return [provider.name for provider in self._providers]

    def resolve_with_provider(self, tool_id: str, *, provider: str | None = None) -> tuple[BaseTool, str] | None:
        """Resolve one tool id together with the provider that answered it."""
        for candidate in self._providers:
            if provider is not None and candidate.name != provider:
                continue
            tool = candidate.resolve(tool_id)
            if tool is not None:
                return tool, candidate.name
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
    """Config-defined + built-in tools assembled by the tool system.

    ``include_mcp=False`` on purpose: MCP tools come from their own provider
    (:func:`_mcp_tools`) so a caller can name the provider that answered and an
    MCP tool cannot shadow a builtin with the same name.
    """
    from deerflow.tools.tools import get_available_tools

    available = get_available_tools(
        model_name=model_name,
        include_mcp=False,
        subagent_enabled=False,
        include_upload_tool=False,
        app_config=app_config,
    )
    return {getattr(t, "name", ""): t for t in available if getattr(t, "name", "")}


def _mcp_tools() -> dict[str, BaseTool]:
    """Tools from every enabled MCP server — the MCP provider (N1 §9).

    Keeps the invariant the ``include_mcp=True`` assembly path established: each
    tool is tagged with its MCP metadata (``tag_mcp_tool``) so deferred-tool
    filtering keeps working for an AI node that resolves an MCP tool through its
    capability groups.  Fail-open (no configured servers, or the MCP extra not
    installed → no MCP provider tools) exactly like the inline path it replaces.
    """
    try:
        from deerflow.config.extensions_config import ExtensionsConfig
        from deerflow.mcp.cache import get_cached_mcp_tools
        from deerflow.tools.mcp_metadata import tag_mcp_tool

        if not ExtensionsConfig.from_file().get_enabled_mcp_servers():
            return {}
        tools = get_cached_mcp_tools() or []
    except ImportError:
        logger.warning("Tool gateway: MCP support unavailable (install 'langchain-mcp-adapters' to enable MCP tools)")
        return {}
    except Exception as e:  # noqa: BLE001 - fail-open provider
        logger.warning("Tool gateway: MCP provider unavailable: %s", e)
        return {}

    resolved: dict[str, BaseTool] = {}
    for tool in tools:
        name = getattr(tool, "name", "")
        if not name:
            continue
        tag_mcp_tool(tool)
        resolved[name] = tool
    return resolved


def _app_tools(*, app_config: Any, instance_repo: Any = None, user_id: str | None = None) -> dict[str, BaseTool]:
    """One tool per *available* registered local application (N5).

    Each tool runs one script command against the application's shared session
    manager (launch/attach → run → collect), returning stdout and artifact
    paths as JSON.  Unavailable applications (driver cannot construct, command
    missing) are skipped so the tool list stays truthful — fail-open per app.
    N6: when an instance repository is available it is written through
    best-effort (the tool runs outside the workflow node context, so the repo is
    captured at gateway-build time from ``runtime.context``).
    """
    from langchain_core.tools import StructuredTool
    from pydantic import BaseModel, Field

    from deerflow.apps.registry import AppRegistry
    from deerflow.config.apps_config import AppsConfig, get_apps_config
    from deerflow.runtime.user_context import DEFAULT_USER_ID

    if isinstance(app_config, AppsConfig):
        apps_config = app_config
    else:
        nested = getattr(app_config, "apps", None)
        apps_config = nested if isinstance(nested, AppsConfig) else get_apps_config()
    registry = AppRegistry.from_config(apps_config)
    owner = user_id or DEFAULT_USER_ID

    class AppRunInput(BaseModel):
        script: str = Field(default="", description="Script command to run in the application (may be empty).")
        args: list[str] = Field(default_factory=list, description="Extra script arguments.")

    def _make_runner(app_name: str):
        async def _run(script: str = "", args: list[str] | None = None) -> str:
            import asyncio
            import json

            from deerflow.apps.persistence import record_launch, record_operation
            from deerflow.apps.session import AppHumanPresentError, get_session_manager
            from deerflow.resources.governor import ResourceUnavailableError

            manager = get_session_manager()
            try:
                session = await asyncio.to_thread(manager.launch, app_name)
                await record_launch(instance_repo, session, user_id=owner)
                result = await asyncio.to_thread(manager.run_script, session, script=script or None, args=list(args or []))
                await record_operation(instance_repo, session, user_id=owner, status=session.status, resource_deltas={"scripts_run": 1})
                artifacts = await asyncio.to_thread(manager.collect, session)
            except ResourceUnavailableError as exc:
                # N8: report the blocking quota/license as data, so the calling
                # agent can wait and retry instead of seeing an opaque error.
                return json.dumps({"app": app_name, "status": "resource_unavailable", "error": str(exc)}, ensure_ascii=False)
            except AppHumanPresentError as exc:
                # N10b (§17): a person is using the application and the configured
                # policy refused. Reported as data (like the quota case) so the
                # agent can tell the user instead of treating it as a crash.
                return json.dumps(
                    {
                        "app": app_name,
                        "status": "human_present",
                        "presence": exc.decision.presence.to_dict(),
                        "error": str(exc),
                    },
                    ensure_ascii=False,
                )
            await record_operation(instance_repo, session, user_id=owner, status=session.status, resource_deltas={"artifacts": len(artifacts)})
            return json.dumps(
                {
                    "app": app_name,
                    "session_id": session.session_id,
                    "status": result.status,
                    "holder": session.holder,
                    "exit_code": result.exit_code,
                    "stdout": result.stdout,
                    "stderr": result.stderr,
                    "artifacts": artifacts,
                },
                ensure_ascii=False,
            )

        return _run

    tools: dict[str, BaseTool] = {}
    available_apps: list[str] = []
    for name, definition in registry.entries():
        try:
            if not registry.build_driver(name).available(definition):
                continue
        except Exception as e:  # noqa: BLE001 - fail-open per app
            logger.warning("Tool gateway: app %r driver unavailable: %s", name, e)
            continue
        available_apps.append(name)
        tool_name = f"app_{name}"
        tools[tool_name] = StructuredTool.from_function(
            coroutine=_make_runner(name),
            name=tool_name,
            description=f"Run a script command in the local application '{name}'. {definition.description}".strip(),
            args_schema=AppRunInput,
        )
    if available_apps:
        tools[PRESENCE_TOOL_NAME] = _presence_tool(available_apps)
    return tools


#: N10b: read-only presence check the agent can call before taking an application.
PRESENCE_TOOL_NAME = "check_app_presence"


def _presence_tool(app_names: list[str]) -> BaseTool:
    """Build the ``check_app_presence`` tool over the available applications.

    Read-only and purely informational: the *enforcement* lives in the session
    manager (every acquisition passes through it), so an agent that never calls
    this tool is still governed.  Its value is letting the agent decide *before*
    it spends a node on an application a person is using, and having the answer
    in the transcript when it does not.
    """
    from langchain_core.tools import StructuredTool
    from pydantic import BaseModel, Field

    catalog = ", ".join(app_names)

    class PresenceInput(BaseModel):
        app: str = Field(description=f"Registered local application name. One of: {catalog}")

    async def _run(app: str) -> str:
        import asyncio
        import json

        from deerflow.apps.session import AppDisabledError, AppNotFoundError, get_session_manager

        manager = get_session_manager()
        try:
            report = await asyncio.to_thread(manager.probe_presence, app, force=True)
        except (AppDisabledError, AppNotFoundError) as exc:
            return json.dumps({"app": app, "status": "unknown_app", "error": str(exc)}, ensure_ascii=False)
        return json.dumps(
            {
                "app": app,
                "state": report.state,
                "detail": report.detail,
                "observed_at": report.observed_at,
                "note": "unknown means the application publishes no presence probe; it does not mean the application is free",
            },
            ensure_ascii=False,
        )

    return StructuredTool.from_function(
        coroutine=_run,
        name=PRESENCE_TOOL_NAME,
        description=f"Check whether a person is currently using a local application before driving it. Registered applications: {catalog}",
        args_schema=PresenceInput,
    )


def build_default_tool_gateway(*, model_name: str | None = None, app_config: Any = None, instance_repo: Any = None, user_id: str | None = None) -> ToolGateway:
    """Build the gateway with the sandbox / builtin / MCP / app providers.

    Fail-open per provider: a provider that cannot be constructed (missing
    config, import error) is skipped with a warning rather than failing the
    node.  Registration order is the resolution priority: sandbox first (a name
    present in both sets prefers the sandbox command/file tool), then builtin,
    then MCP, then app last so sandbox/builtin/MCP names always win a collision
    with an application tool.
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
        gateway.add_provider(StaticToolProvider(PROVIDER_MCP, _mcp_tools()))
    except Exception as e:  # noqa: BLE001 - fail-open provider
        logger.warning("Tool gateway: MCP provider unavailable: %s", e)

    try:
        gateway.add_provider(StaticToolProvider(PROVIDER_APP, _app_tools(app_config=app_config, instance_repo=instance_repo, user_id=user_id)))
    except Exception as e:  # noqa: BLE001 - fail-open provider
        logger.warning("Tool gateway: app provider unavailable: %s", e)

    return gateway


def _load_capability_group_closure(references: list[str], *, user_id: str | None) -> list[Any]:
    """Load selected groups plus their ``extends`` bases, de-duplicated by GUID."""
    from deerflow.capability_groups import CapabilityGroupError, load_capability_group_closure
    from deerflow.tools.registry import ToolResolutionError

    try:
        return load_capability_group_closure(references, user_id=user_id)
    except CapabilityGroupError as exc:
        raise ToolResolutionError(f"capability group is not available: {exc}") from exc


def resolve_capability_tools(
    capability_groups: list[str],
    *,
    user_id: str | None = None,
    model_name: str | None = None,
    app_config: Any = None,
    instance_repo: Any = None,
) -> list[BaseTool]:
    """Resolve an AI node's tool set from its capability groups.

    Capability groups are references, not tool definitions: each group lists
    canonical tool ids in ``group.json.tools`` and this function resolves them
    through the unified :class:`~deerflow.tools.registry.ToolRegistry`.

    Explicitly declared tools are never silently dropped.  A missing group,
    package, MCP server/tool, or permission failure raises
    :class:`~deerflow.tools.registry.ToolResolutionError`.
    """
    if not capability_groups:
        return []

    from deerflow.tools.registry import ToolRegistry

    groups = _load_capability_group_closure(capability_groups, user_id=user_id)
    refs: list[str] = []
    permissions: list[str] = []
    overrides: dict[str, tuple[str, ...]] = {}
    for group in groups:
        refs.extend(group.tools)
        permissions.extend(group.permissions)
        for ref, values in group.tool_permissions.items():
            overrides[ref] = tuple(dict.fromkeys((*overrides.get(ref, ()), *values)))

    if not refs:
        return []

    gateway = build_default_tool_gateway(model_name=model_name, app_config=app_config, instance_repo=instance_repo, user_id=user_id)
    registry = ToolRegistry(gateway)
    return registry.resolve(list(dict.fromkeys(refs)), permissions=tuple(permissions), overrides=overrides)


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
    "PROVIDER_MCP",
    "PRESENCE_TOOL_NAME",
]
