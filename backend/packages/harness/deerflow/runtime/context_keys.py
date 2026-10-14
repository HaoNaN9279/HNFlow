"""Private runtime context keys shared across DeerFlow runtime components.

``WORKFLOW_RUNTIME_CONTEXT_KEY`` is the injection point for T18 dialogue-side
workflow dispatch tools: the harness worker packages the Gateway run singletons
(``RunManager`` / ``StreamBridge`` / ``RunContext``) under this key so a tool
reading ``ToolRuntime.context`` can start a workflow run through the same run
lifecycle as the chat entry, instead of building its own engine. A
caller-supplied value for this host-internal key is never authoritative.
"""

from typing import Final

CURRENT_RUN_PRE_EXISTING_MESSAGE_IDS_KEY: Final[str] = "__deerflow_pre_run_message_ids"
WORKFLOW_RUNTIME_CONTEXT_KEY: Final[str] = "__workflow_runtime"
#: Injection point for the local-application session manager (N4): the Gateway
#: run worker packages a process-wide ``AppSessionManager`` under this key so
#: the ``app:*`` workflow executors share one session map. A caller-supplied
#: value for this host-internal key is never authoritative.
APP_RUNTIME_CONTEXT_KEY: Final[str] = "__app_session_manager"
#: Injection point for the durable local-application instance repository (N6):
#: the Gateway run worker packages an ``AppInstanceRepository`` under this key
#: so the ``app:*`` executors write instance records through (best-effort). It
#: is ``None`` on the memory backend. A caller-supplied value for this
#: host-internal key is never authoritative.
APP_INSTANCE_REPO_CONTEXT_KEY: Final[str] = "__app_instance_repo"
