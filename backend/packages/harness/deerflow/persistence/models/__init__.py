"""ORM model registration entry point.

Importing this module ensures all ORM models are registered with
``Base.metadata`` so Alembic autogenerate detects every table.

The actual ORM classes have moved to entity-specific subpackages:
- ``deerflow.persistence.thread_meta``
- ``deerflow.persistence.run``

``RunEventRow`` remains in ``deerflow.persistence.models.run_event`` because
its storage implementation lives in ``deerflow.runtime.events.store.db`` and
there is no matching entity directory.
"""

from deerflow.persistence.agents.model import AgentRow
from deerflow.persistence.app_instances.model import AppInstanceRow
from deerflow.persistence.human_tasks.model import HumanTaskRow
from deerflow.persistence.mcp_tasks.model import McpTaskRow
from deerflow.persistence.model_profiles.model import ModelProfileRow
from deerflow.persistence.models.run_event import RunEventRow
from deerflow.persistence.projects.model import ProjectRow
from deerflow.persistence.run.model import RunRow
from deerflow.persistence.scheduled_task_runs.model import ScheduledTaskRunRow
from deerflow.persistence.scheduled_tasks.model import ScheduledTaskRow
from deerflow.persistence.specifications.model import WorkflowSpecificationRow
from deerflow.persistence.specifications.revision_model import WorkflowSpecificationRevisionRow
from deerflow.persistence.thread_meta.model import ThreadMetaRow
from deerflow.persistence.workflow_definitions.model import WorkflowDefinitionRow
from deerflow.persistence.workflow_definitions.revision_model import WorkflowDefinitionRevisionRow
from deerflow.persistence.workflow_folders.model import WorkflowFolderRow
from deerflow.persistence.workflow_undo.model import WorkflowUndoRow
from deerflow.persistence.workflow_workbenches.model import (
    WorkflowWorkbenchMemberRow,
    WorkflowWorkbenchRow,
)
from deerflow.persistence.workspace_changes.model import WorkspaceChangeRow

__all__ = [
    "AgentRow",
    "AppInstanceRow",
    "HumanTaskRow",
    "McpTaskRow",
    "ModelProfileRow",
    "ProjectRow",
    "RunEventRow",
    "RunRow",
    "ScheduledTaskRow",
    "ScheduledTaskRunRow",
    "ThreadMetaRow",
    "WorkflowSpecificationRow",
    "WorkflowSpecificationRevisionRow",
    "WorkflowDefinitionRow",
    "WorkflowDefinitionRevisionRow",
    "WorkflowFolderRow",
    "WorkflowUndoRow",
    "WorkspaceChangeRow",
    "WorkflowWorkbenchMemberRow",
    "WorkflowWorkbenchRow",
]
