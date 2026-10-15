"""External-tool workflow executors.

Each executor follows the ``Executor`` contract:
``(runtime: WorkflowRuntime, params: dict, inputs: dict) -> dict``.

Non-idempotent executors (bash, http) require ``params.crash_confirm is True``
before they execute; without it they raise :class:`WorkflowExecutionError`.
"""

from __future__ import annotations

import logging
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


# ── nested:subworkflow ───────────────────────────────────────────────────────


def exec_nested_subworkflow(runtime: WorkflowRuntime, params: dict[str, Any], inputs: dict[str, Any]) -> dict[str, Any]:
    """Placeholder — nested subworkflow executor not yet implemented (planned T10)."""
    raise WorkflowExecutionError(
        "nested:subworkflow without a subworkflow spec or with mode=delegate requires the delegate executor path; "
        "specify params.subworkflow with type='template' and mode='delegate' for runtime delegation, "
        "or type='inline'/'template' with mode='compile' for compile-time expansion"
    )
