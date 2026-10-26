---
name: workspace-manager
description: Inspect and safely manage HNFlow workflows and workflow folders with the Lead Agent workspace tools. Use when the user asks to create, edit, reorganize, delete, or audit workspace resources.
allowed-tools:
  - workspace_catalog
  - workspace_get
  - workflow_manage
  - workspace_undo
  - read_file
  - describe_skill
  - tool_search
---

# Workspace manager

Use this skill whenever the task touches saved workflows, workflow folders,
or read-only workbench metadata.

## Resource model

- `workflow` — a saved `WorkflowDefinition` with nodes, edges, metadata, version, and optional folder.
- `workflow_folder` — an arbitrary-depth directory for workflows.
- `tool`, `capability_group`, `model_profile`, `skill` — read-only catalogs used for authoring.

## Workflow

1. Start with `workspace_catalog(section="index")` to see counts and categories.
2. Read the affected resource with `workspace_get` before changing it. Keep the
   returned `updated_at` (workflow/folder).
3. Create with `workflow_manage(action="create")`.
4. Prefer `workflow_manage(action="patch", operations=[...])` over rewriting
   the full definition. Supported operations: `add_node`, `update_node`,
   `remove_node`, `add_edge`, `update_edge`, `remove_edge`, `set_metadata`,
   `set_name`, `set_version`.
5. Pass `expected_updated_at` on update/delete. Never retry a conflict by
   silently dropping the token.
6. Delete only with `confirm=true`.

## Workbench

Workbenches are project files under `<project>/.hnflow/workbenches/`. They are
not mutated through workspace tools. Use the project workbench API or edit the
JSON file directly; removing a workflow from a workbench never deletes the
workflow.

## Undo

Every write is journaled per conversation turn. After a turn that changed
resources, report that the user can undo it. Use `workspace_undo(action="list")`
to inspect what is available and `workspace_undo(action="undo")` only when the
user asks to revert. Undo is all-or-nothing; on a conflict, explain which
resource changed and do not force a revert.

## Rules

- Never use `bash`, `curl`, or direct database access to change workspace resources.
- Never change read-only catalogs (`tool`, `capability_group`, `model_profile`) through this skill.
- Do not delete a non-empty folder; move or delete its contents first.
- After a write, report the resource kind, id, name, and the user-visible change.
- Keep catalog reads compact: use the category index before fetching full definitions.
