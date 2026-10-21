"""Narrow port between the workflow engine and a replaceable Agent runtime.

HNFlow owns the graph, run lifecycle, tools, sandbox, local applications and
human tasks.  An Agent only owns the reasoning loop.  This module is the only
contract an AI node uses, so DeerFlow, a LangGraph subgraph, a local CLI agent
or a remote HTTP agent can be swapped without changing the compiler or the
canvas.

The default adapter deliberately wraps the existing ``SubagentExecutor`` so the
port can be introduced without changing behavior.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable

from deerflow.workflow.schema import Port

#: Runtime-context key for injecting a custom agent adapter.
AGENT_ADAPTER_CONTEXT_KEY = "__agent_adapter"

#: Capability tiers from the development plan.  A node declares what it needs;
#: the runtime refuses an adapter that cannot provide it.
CAP_TEXT = "text"
CAP_STREAM = "stream"
CAP_TOOLS = "tools"
CAP_RESUME = "resume"
CAP_ASSETS = "assets"
CAP_USAGE = "usage"


@dataclass(frozen=True)
class AgentManifest:
    """What an adapter can actually do.

    ``capabilities`` is a set of the ``CAP_*`` constants.  The port is
    intentionally conservative: a text-only external agent must not be selected
    for a node that declares tools or resumable interrupts.
    """

    name: str
    version: str
    capabilities: frozenset[str] = field(default_factory=frozenset)

    def supports(self, capability: str) -> bool:
        return capability in self.capabilities


@dataclass(frozen=True)
class AgentTurnRequest:
    """One AI-node turn handed to an Agent adapter.

    ``task`` is the user turn; ``system_prompt`` carries the assembled identity,
    capability, examples, context and schema buckets.  They are deliberately
    separate so an adapter never has to re-infer which part is instruction.
    """

    task: str
    system_prompt: str | None = None
    tools: list[Any] = field(default_factory=list)
    name: str = "ai:node"
    description: str = "Execute an AI workflow node"
    disallowed_tools: list[str] = field(default_factory=lambda: ["ask_clarification", "present_files"])
    checkpointer: bool = False
    checkpointer_instance: Any | None = None
    allow_recursion: bool = False
    max_turns: int = 50
    timeout_seconds: int = 900
    token_budget: Any | None = None
    model: str = "inherit"
    delegation_depth: int = 0
    user_id: str | None = None
    app_config: Any | None = None
    context_compression: Any | None = None
    thread_id: str | None = None
    checkpoint_thread_id: str | None = None
    resume_checkpoint_id: str | None = None
    required_capabilities: frozenset[str] = field(default_factory=frozenset)
    output_ports: tuple[Port, ...] = ()


@dataclass(frozen=True)
class AgentTurnResult:
    """Normalized result returned by every adapter."""

    status: Any
    result: Any = None
    error: Any = None
    token_usage_records: list[dict[str, Any]] | None = None
    stop_reason: str | None = None
    raw: Any = None


@runtime_checkable
class AgentPort(Protocol):
    """The only Agent interface an AI node may depend on."""

    manifest: AgentManifest

    async def execute(self, request: AgentTurnRequest) -> AgentTurnResult:
        """Run one turn and return a normalized result."""
        ...


class DeerFlowAgentAdapter:
    """Default adapter: the existing in-process ``SubagentExecutor``.

    Keeping the adapter thin is deliberate.  It preserves the current
    SubagentConfig/executor behavior while giving the workflow layer a seam that
    does not import ``deerflow.subagents`` at module scope.
    """

    manifest = AgentManifest(
        name="deerflow",
        version="1",
        capabilities=frozenset({CAP_TEXT, CAP_STREAM, CAP_TOOLS, CAP_USAGE}),
    )

    async def execute(self, request: AgentTurnRequest) -> AgentTurnResult:
        # Lazy imports keep the compiler import graph free of the agent graph
        # and let tests replace the package export.
        from deerflow.subagents import SubagentExecutor
        from deerflow.subagents.config import SubagentConfig

        config = SubagentConfig(
            name=request.name,
            description=request.description,
            system_prompt=request.system_prompt,
            tools=None,
            disallowed_tools=list(request.disallowed_tools),
            checkpointer=request.checkpointer,
            allow_recursion=request.allow_recursion,
            max_turns=request.max_turns,
            timeout_seconds=request.timeout_seconds,
            token_budget=request.token_budget,
            model=request.model,
            context_compression=request.context_compression,
        )
        executor_kwargs: dict[str, Any] = {
            "config": config,
            "tools": request.tools,
            "delegation_depth": request.delegation_depth,
        }
        if request.user_id is not None:
            executor_kwargs["user_id"] = request.user_id
        if request.app_config is not None:
            executor_kwargs["app_config"] = request.app_config
        if request.thread_id is not None:
            executor_kwargs["thread_id"] = request.thread_id
        if request.checkpointer:
            executor_kwargs["checkpointer"] = request.checkpointer_instance
        if request.checkpoint_thread_id is not None:
            executor_kwargs["checkpoint_thread_id"] = request.checkpoint_thread_id
        # Keep the None key for a first continue turn: the executor's contract
        # distinguishes "resume from no checkpoint" from "not a session run".
        executor_kwargs["resume_checkpoint_id"] = request.resume_checkpoint_id

        executor = SubagentExecutor(**executor_kwargs)
        raw = await executor._aexecute(request.task)
        return AgentTurnResult(
            status=getattr(raw, "status", None),
            result=getattr(raw, "result", None),
            error=getattr(raw, "error", None),
            token_usage_records=getattr(raw, "token_usage_records", None),
            stop_reason=getattr(raw, "stop_reason", None),
            raw=raw,
        )


def get_agent_adapter(runtime: Any) -> AgentPort:
    """Resolve the adapter for this run, defaulting to DeerFlow."""
    context = getattr(runtime, "context", None)
    if isinstance(context, dict):
        candidate = context.get(AGENT_ADAPTER_CONTEXT_KEY)
        if candidate is not None:
            return candidate
    return DeerFlowAgentAdapter()


def check_agent_capabilities(adapter: AgentPort, required: frozenset[str]) -> None:
    """Fail loud when an AI node needs capabilities the adapter lacks."""
    missing = sorted(cap for cap in required if not adapter.manifest.supports(cap))
    if missing:
        raise ValueError(f"agent '{adapter.manifest.name}' lacks required capabilities: {', '.join(missing)}")


__all__ = [
    "AGENT_ADAPTER_CONTEXT_KEY",
    "AgentManifest",
    "AgentPort",
    "AgentTurnRequest",
    "AgentTurnResult",
    "CAP_ASSETS",
    "CAP_RESUME",
    "CAP_STREAM",
    "CAP_TEXT",
    "CAP_TOOLS",
    "CAP_USAGE",
    "DeerFlowAgentAdapter",
    "check_agent_capabilities",
    "get_agent_adapter",
]
