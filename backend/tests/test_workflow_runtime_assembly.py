"""Contract tests for the single workflow runtime assembly point.

These pin the two failures that made production differ from unit tests:

- the compiler must receive previewers, not just executors, so approval nodes
  are not rejected at compile time;
- ``config['context']`` must carry the run owner and the capability services
  (tool gateway, app manager, optional stores), so HumanTasks and
  ``tool:invoke`` work in a real run.
"""

from __future__ import annotations

from types import SimpleNamespace

from deerflow.runtime.context_keys import APP_INSTANCE_REPO_CONTEXT_KEY, APP_RUNTIME_CONTEXT_KEY
from deerflow.runtime.user_context import DEFAULT_USER_ID
from deerflow.workflow.executors import build_default_registry
from deerflow.workflow.runtime_context import build_workflow_compile_context, build_workflow_runtime_context


def test_compile_context_carries_previews() -> None:
    registry = build_default_registry()
    ctx = build_workflow_compile_context(registry)

    assert ctx.executors
    assert ctx.previews, "approval previewers must travel with the executors"
    assert ctx.resource_accessors, "automatic resource accessors must travel with the executors"


def test_runtime_context_uses_run_owner_and_origin_run_id() -> None:
    record = SimpleNamespace(run_id="run-new", thread_id="thread-1", user_id="alice")
    run_ctx = SimpleNamespace(checkpointer=object(), app_config=None, app_instance_repo=None)
    gateway = object()

    context = build_workflow_runtime_context(
        record=record,
        run_ctx=run_ctx,
        tool_gateway=gateway,
        origin_run_id="run-original",
    )

    assert context["user_id"] == "alice"
    assert context["thread_id"] == "thread-1"
    assert context["run_id"] == "run-original"
    assert context["tool_gateway"] is gateway
    assert APP_RUNTIME_CONTEXT_KEY in context


def test_runtime_context_falls_back_to_default_user() -> None:
    record = SimpleNamespace(run_id="run", thread_id="thread", user_id=None)
    run_ctx = SimpleNamespace(checkpointer=None, app_config=None, app_instance_repo=None)

    context = build_workflow_runtime_context(record=record, run_ctx=run_ctx)

    assert context["user_id"] == DEFAULT_USER_ID
    assert context["run_id"] == "run"


def test_runtime_context_injects_app_instance_repo() -> None:
    record = SimpleNamespace(run_id="run", thread_id="thread", user_id="u")
    repo = object()
    run_ctx = SimpleNamespace(checkpointer=None, app_config=None, app_instance_repo=repo)

    context = build_workflow_runtime_context(record=record, run_ctx=run_ctx)

    assert context[APP_INSTANCE_REPO_CONTEXT_KEY] is repo


def test_extra_cannot_override_ownership_keys() -> None:
    record = SimpleNamespace(run_id="run", thread_id="thread", user_id="owner")
    run_ctx = SimpleNamespace(checkpointer=None, app_config=None, app_instance_repo=None)

    context = build_workflow_runtime_context(
        record=record,
        run_ctx=run_ctx,
        extra={"user_id": "forged", "run_id": "forged", "custom": "ok"},
    )

    assert context["user_id"] == "owner"
    assert context["run_id"] == "run"
    assert context["custom"] == "ok"
