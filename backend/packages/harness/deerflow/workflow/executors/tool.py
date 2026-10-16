"""External-tool workflow executors.

Each executor follows the ``Executor`` contract:
``(runtime: WorkflowRuntime, params: dict, inputs: dict) -> dict``.

Non-idempotent executors (bash, http) require ``params.crash_confirm is True``
before they execute; without it they raise :class:`WorkflowExecutionError`.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import logging
import re
import uuid
from typing import Any

import httpx

from deerflow.sandbox import tools as sandbox_tools
from deerflow.workflow.compiler import WorkflowRuntime
from deerflow.workflow.executors import WorkflowExecutionError
from deerflow.workflow.reliability import IDEMPOTENCY_ENV, IDEMPOTENCY_HEADER, IDEMPOTENCY_PARAM

logger = logging.getLogger(__name__)

# ── helpers ──────────────────────────────────────────────────────────────────


def _require_crash_confirm(params: dict[str, Any], node_label: str) -> None:
    """Raise if ``params.crash_confirm`` is not truthy."""
    if params.get("crash_confirm") is not True:
        raise WorkflowExecutionError(f"{node_label}: node requires crash_confirm=true (non-idempotent execution must be explicitly confirmed)")


# ── tool:bash ────────────────────────────────────────────────────────────────


def exec_bash(runtime: WorkflowRuntime, params: dict[str, Any], inputs: dict[str, Any]) -> dict[str, Any]:
    """Execute a shell command inside the sandbox.

    **Security boundary**: this executor MUST route through the sandbox
    provider — it never invokes a subprocess directly on the host.

    Requires ``params.crash_confirm is True`` because shell execution is
    non-idempotent.
    """
    _require_crash_confirm(params, "tool:bash")

    command: str = params.get("command", "")
    if not command:
        raise WorkflowExecutionError("tool:bash: missing required param 'command'")

    env: dict[str, str] | None = params.get("env")
    timeout: float | None = params.get("timeout")

    # N14 §24.7: forward the stable idempotency key (injected by the compiler
    # when the node declares ``params.idempotency``) as an env var so a retried
    # script can recognise a repeat.  An explicitly configured value wins.
    idempotency_key = params.get(IDEMPOTENCY_PARAM)
    if idempotency_key:
        merged_env = dict(env or {})
        merged_env.setdefault(IDEMPOTENCY_ENV, str(idempotency_key))
        env = merged_env

    # Acquire sandbox through the standard lazy-init path.
    # WorkflowRuntime is duck-type compatible with the Runtime expected
    # by ensure_sandbox_initialized (both expose .state / .context / .config).
    sandbox = sandbox_tools.ensure_sandbox_initialized(runtime)  # type: ignore[arg-type]

    # Apply virtual-path translation and secret masking (defence-in-depth;
    # LocalSandbox already translates paths internally).
    thread_data = sandbox_tools.get_thread_data(runtime)  # type: ignore[arg-type]
    translated = sandbox_tools.replace_virtual_paths_in_command(command, thread_data)

    output: str = sandbox.execute_command(translated, env=env, timeout=timeout)

    # Mask any injected secret values from the output before returning.
    active_secrets = runtime.state.get("__active_skill_secrets", {})
    output = sandbox_tools.mask_secret_values(output, active_secrets)

    return {"out": output}


# ── tool:http ────────────────────────────────────────────────────────────────


async def exec_http(runtime: WorkflowRuntime, params: dict[str, Any], inputs: dict[str, Any]) -> dict[str, Any]:
    """Perform an HTTP request with httpx.

    ``params.method`` (GET/POST/PUT/DELETE/PATCH, default GET),
    ``params.url``, optional ``params.headers``, ``params.json``,
    ``params.params`` (query string), ``params.timeout`` (default 30 s).

    Requires ``params.crash_confirm is True`` because outbound HTTP is
    non-idempotent.
    """
    _require_crash_confirm(params, "tool:http")

    url: str = params.get("url", "")
    if not url:
        raise WorkflowExecutionError("tool:http: missing required param 'url'")

    method: str = (params.get("method") or "GET").upper()
    headers: dict[str, str] | None = params.get("headers")
    json_body: Any = params.get("json")
    query_params: dict[str, str] | None = params.get("params")
    timeout: float = float(params.get("timeout", 30))

    # N14 §24.7: forward the stable idempotency key (injected by the compiler
    # when the node declares ``params.idempotency``) as an ``Idempotency-Key``
    # request header so a retried request can be deduped by the server.  An
    # explicitly configured header wins.
    idempotency_key = params.get(IDEMPOTENCY_PARAM)
    if idempotency_key:
        merged_headers = dict(headers or {})
        merged_headers.setdefault(IDEMPOTENCY_HEADER, str(idempotency_key))
        headers = merged_headers

    async with httpx.AsyncClient(timeout=httpx.Timeout(timeout)) as client:
        response = await client.request(
            method=method,
            url=url,
            headers=headers,
            json=json_body,
            params=query_params,
        )

    result: dict[str, Any] = {
        "status_code": response.status_code,
        "headers": dict(response.headers),
    }

    # Best-effort JSON parsing; fall back to text on failure.
    try:
        result["json"] = response.json()
    except Exception:
        try:
            result["text"] = response.text
        except Exception:
            result["text"] = str(response.content, errors="replace")

    return {"out": result}


# ── tool:log ─────────────────────────────────────────────────────────────────


def exec_log(runtime: WorkflowRuntime, params: dict[str, Any], inputs: dict[str, Any]) -> dict[str, Any]:
    """Log a message and pass through inputs unchanged.

    Logs ``params.message`` if present, otherwise ``inputs.in``.
    Idempotent — repeated execution is harmless.
    """
    message = params.get("message") or inputs.get("in")
    logger.info("workflow log: %s", message)
    return {"out": inputs.get("in")}


# ── tool:notify ──────────────────────────────────────────────────────────────


def exec_notify(runtime: WorkflowRuntime, params: dict[str, Any], inputs: dict[str, Any]) -> dict[str, Any]:
    """Emit a user-facing notification for a long-running workflow (local, C7).

    Prompts never carry a notification transport, so delivery is pluggable:

    - When ``runtime.context`` exposes a ``notifier`` (or ``notify``) callable —
      the host hook the Gateway / desktop shell / IM bridge injects — it is
      invoked once with the notification record ``{title, message, level}``.
    - Otherwise the notification is logged at ``WARNING`` so a headless
      single-machine deployment still surfaces it in the Gateway log.

    Always returns the record (plus ``delivered``) on the ``out`` port so a
    downstream node can branch on delivery.  Idempotent: re-emitting on retry
    is harmless logging/bookkeeping, not a side effect on external state.
    """
    message = params.get("message")
    if message is None:
        message = inputs.get("in")
    record: dict[str, Any] = {
        "title": params.get("title"),
        "message": "" if message is None else str(message),
        "level": params.get("level") or "info",
    }

    notifier = None
    context = getattr(runtime, "context", None)
    if isinstance(context, dict):
        candidate = context.get("notifier") or context.get("notify")
        if callable(candidate):
            notifier = candidate

    delivered = False
    if notifier is not None:
        try:
            notifier(dict(record))
            delivered = True
        except Exception:
            logger.warning("tool:notify notifier callable failed; falling back to log", exc_info=True)

    if not delivered:
        logger.warning("workflow notification [%s]%s: %s", record["level"], f" {record['title']}" if record["title"] else "", record["message"])

    return {"out": {**record, "delivered": delivered}}


# ── tool:invoke (§25 工具节点化) ───────────────────────────────────────────────


def _interpolate_arguments(arguments: Any, inputs: dict[str, Any]) -> Any:
    """Resolve ``{{port}}`` placeholders in a tool-argument tree.

    Mirrors the task-template interpolation the prompt/task layer already uses
    (``{{port}}`` → the node's input value), applied recursively to dicts and
    lists so a tool taking nested arguments can be wired from upstream ports.
    A placeholder naming an absent port becomes an empty string (the same
    lenient rule as ``render_query`` — a missing optional port must not abort
    the node), and a value that is *exactly* one placeholder keeps the input's
    original type instead of being stringified.
    """
    if isinstance(arguments, str):
        return _render_placeholder(arguments, inputs)
    if isinstance(arguments, dict):
        return {key: _interpolate_arguments(value, inputs) for key, value in arguments.items()}
    if isinstance(arguments, list):
        return [_interpolate_arguments(item, inputs) for item in arguments]
    return arguments


_PLACEHOLDER = re.compile(r"\{\{([A-Za-z0-9_.-]+)\}\}")


def _render_placeholder(template: str, inputs: dict[str, Any]) -> Any:
    exact = _PLACEHOLDER.fullmatch(template)
    if exact is not None:
        return inputs.get(exact.group(1), "")
    return _PLACEHOLDER.sub(lambda match: str(inputs.get(match.group(1), "")), template)


def _build_tool_runtime(runtime: WorkflowRuntime) -> Any:
    """Build the LangChain ``ToolRuntime`` a runtime-injected tool expects.

    DeerFlow's sandbox/app tools declare a plain ``runtime`` parameter.  The
    executor passes it explicitly on the direct-call path (:func:`_call_tool`),
    which is what makes a graph invocation of those tools possible at all.
    """
    from langchain.tools import ToolRuntime

    return ToolRuntime(
        state=runtime.state or {},
        context=runtime.context if isinstance(runtime.context, dict) else {},
        config=runtime.config or {},
        stream_writer=lambda _chunk: None,
        tool_call_id=f"wf-invoke-{uuid.uuid4().hex}",
        store=None,
        tools=[],
    )


async def _call_tool(tool: Any, arguments: dict[str, Any], *, tool_runtime: Any, tool_name: str) -> Any:
    """Invoke one resolved tool, delivering ``runtime`` to tools that declare it.

    **Why not just ``tool.ainvoke(arguments)``**: a tool whose function
    annotates its injected parameter with ``Annotated[..., InjectedToolArg]``
    loses that marker once its module uses ``from __future__ import annotations``
    (the annotation becomes a string).  LangChain then fills the parameter with
    ``None`` and *ignores* a value supplied in the args mapping, so a
    runtime-dependent tool would run with no runtime and fail obscurely.  Calling
    the tool's own function with an explicitly checked ``runtime`` keyword is
    annotation-independent: the signature says whether it is wanted.

    Arguments are validated through the tool's own schema first (defaults filled,
    types coerced, unknown keys rejected) so a typo in ``params.arguments`` is
    reported against the tool rather than surfacing as a stray ``TypeError``.
    A tool exposing no function at all (an opaque ``BaseTool`` subclass) falls
    back to the framework path — documented, and the only case where runtime
    injection is not guaranteed.
    """
    fn = getattr(tool, "coroutine", None) or getattr(tool, "func", None)
    if fn is None:
        return await tool.ainvoke(arguments)

    schema = getattr(tool, "tool_call_schema", None) or getattr(tool, "args_schema", None)
    if schema is not None and hasattr(schema, "model_validate"):
        try:
            kwargs = schema.model_validate(arguments).model_dump()
        except Exception as exc:  # noqa: BLE001 — report the tool's own schema verdict
            raise WorkflowExecutionError(f"tool:invoke: arguments for {tool_name!r} are invalid: {exc}") from exc
    else:
        kwargs = dict(arguments)

    try:
        parameters = inspect.signature(fn).parameters
    except (TypeError, ValueError):  # pragma: no cover — builtins/C callables
        parameters = {}
    if "runtime" in parameters:
        kwargs["runtime"] = tool_runtime

    if inspect.iscoroutinefunction(fn):
        return await fn(**kwargs)
    # A sync tool would block the event loop; offload it (repo convention).
    return await asyncio.to_thread(fn, **kwargs)


async def exec_tool_invoke(runtime: WorkflowRuntime, params: dict[str, Any], inputs: dict[str, Any]) -> dict[str, Any]:
    """Call one gateway tool directly from the graph (§25 工具节点化).

    Before this the only way to reach a tool was inside an ``ai:llm_agent`` node
    (a model had to choose it) or through a bespoke ``tool:*`` node.  This node
    makes any gateway tool — sandbox file/command tools, builtins, and the local
    application tools — first-class graph steps, so a workflow can call a
    deterministic tool without spending a model turn on choosing it.

    ``params.tool`` (required) names the tool; ``params.provider`` optionally
    restricts resolution to one provider (``sandbox``/``builtin``/``app``) when
    the same id exists in several.  ``params.arguments`` is the tool's argument
    mapping and supports ``{{port}}`` interpolation from the node's inputs.

    Requires ``params.crash_confirm is True``: the node is non-idempotent by
    construction (the resolved tool may write files, drive a local application,
    or perform network IO), and the engine cannot infer otherwise — the honest
    default is an explicit confirmation.
    """
    _require_crash_confirm(params, "tool:invoke")

    tool_name = params.get("tool")
    if not isinstance(tool_name, str) or not tool_name.strip():
        raise WorkflowExecutionError("tool:invoke: missing required param 'tool' (the gateway tool id to call)")
    tool_name = tool_name.strip()

    provider = params.get("provider")
    if provider is not None and (not isinstance(provider, str) or not provider.strip()):
        raise WorkflowExecutionError("tool:invoke: 'provider' must be a non-empty string when set")
    provider_name = provider.strip() if isinstance(provider, str) else None

    arguments = _interpolate_arguments(params.get("arguments") or {}, inputs)
    if not isinstance(arguments, dict):
        raise WorkflowExecutionError("tool:invoke: 'arguments' must be an object")

    context = runtime.context if isinstance(runtime.context, dict) else {}
    gateway = context.get("tool_gateway")
    if gateway is None:
        # Fail loud rather than building a gateway here: a silently-constructed
        # gateway would resolve a *different* tool set than the run was admitted
        # with (config drift), which is exactly the kind of surprise a
        # deterministic graph step must not have.
        raise WorkflowExecutionError("tool:invoke: no 'tool_gateway' in runtime context (inject one to call tools directly from the graph)")

    resolved = gateway.resolve_with_provider(tool_name, provider=provider_name)
    if resolved is None:
        scope = f" (provider={provider_name!r})" if provider_name else ""
        raise WorkflowExecutionError(f"tool:invoke: tool {tool_name!r} could not be resolved by any provider{scope}; registered providers: {gateway.provider_names()}")
    tool, resolved_provider = resolved

    try:
        result = await _call_tool(tool, arguments, tool_runtime=_build_tool_runtime(runtime), tool_name=tool_name)
    except WorkflowExecutionError:
        raise
    except Exception as exc:  # noqa: BLE001 — surface the tool's own failure verbatim
        raise WorkflowExecutionError(f"tool:invoke: tool {tool_name!r} ({resolved_provider}) failed: {type(exc).__name__}: {exc}") from exc

    return {"out": _tool_result_text(result), "result": result, "tool": tool_name, "provider": resolved_provider}


def _tool_result_text(result: Any) -> str:
    """Render a tool result as text for the ``out`` port (never raises)."""
    if isinstance(result, str):
        return result
    try:
        return json.dumps(result, ensure_ascii=False, default=str)
    except Exception:  # noqa: BLE001 — a pathological result must not fail the node
        return str(result)


# ── nested:subworkflow ───────────────────────────────────────────────────────


def exec_nested_subworkflow(runtime: WorkflowRuntime, params: dict[str, Any], inputs: dict[str, Any]) -> dict[str, Any]:
    """Placeholder — nested subworkflow executor not yet implemented (planned T10)."""
    raise WorkflowExecutionError(
        "nested:subworkflow without a subworkflow spec or with mode=delegate requires the delegate executor path; "
        "specify params.subworkflow with type='template' and mode='delegate' for runtime delegation, "
        "or type='inline'/'template' with mode='compile' for compile-time expansion"
    )
