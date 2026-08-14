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
