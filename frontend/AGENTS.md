# AGENTS.md

This file provides guidance to AI coding agents (Claude Code, Codex, and others) when working with the DeerFlow frontend. It is the source of truth for this module.

## Project Overview

DeerFlow Frontend is a Next.js 16 web interface for an AI agent system. It communicates with a LangGraph-based backend to provide thread-based AI conversations in a persistent workspace panel, with a skills/tools system.

**Stack**: Next.js 16, React 19, TypeScript 5.8, Tailwind CSS 4, pnpm 10.26.2. Requires Node.js 22+ and pnpm 10.26.2+.

### Core dependencies

- **LangGraph SDK** (`@langchain/langgraph-sdk` ^1.5.3) — Agent orchestration and streaming
- **LangChain Core** (`@langchain/core` ^1.1.15) — Fundamental AI building blocks
- **TanStack Query** (`@tanstack/react-query` ^5.90.17) — Server state management
- **UI**: Shadcn UI, MagicUI, React Bits, and Vercel AI SDK elements (generated from registries — see Code Style)

## Commands

| Command          | Purpose                                           |
| ---------------- | ------------------------------------------------- |
| `pnpm dev`       | Dev server with Turbopack (http://localhost:3000) |
| `pnpm build`     | Production build                                  |
| `pnpm check`     | Lint + type check (run before committing)         |
| `pnpm lint`      | ESLint only                                       |
| `pnpm lint:fix`  | ESLint with auto-fix                              |
| `pnpm format`    | Prettier check (`pnpm format:write` to apply)     |
| `pnpm test`      | Run unit tests with Rstest                        |
| `pnpm test:e2e`  | Run E2E tests with Playwright (Chromium)          |
| `pnpm typecheck` | TypeScript type check (`tsc --noEmit`)            |
| `pnpm start`     | Start production server                           |

Unit tests live under `tests/unit/` and mirror the `src/` layout (e.g., `tests/unit/core/api/stream-mode.test.ts` tests `src/core/api/stream-mode.ts`). Powered by Rstest; import source modules via the `@/` path alias.

Rstest runs them as two projects (`rstest.config.ts`). `*.test.ts` / `*.test.tsx` run in a plain **node** environment — that is nearly the whole suite, and it is the default for anything that is pure logic. `*.dom.test.ts` / `*.dom.test.tsx` run in **happy-dom**, for tests that need a document: hooks driven through `renderHook` from `@testing-library/react`, and components. Keep the split — a DOM environment costs roughly 3x the runtime of the node suite, so tests that do not render should not opt into it. A hook whose behavior only exists under real React (effect ordering, cleanup on unmount, re-render on store change) belongs in a `.dom.test.*` file rather than a node test that mocks `react` itself.

E2E tests live under `tests/e2e/` and use Playwright with Chromium. They mock all backend APIs via `page.route()` network interception and test real page interactions (navigation, chat input, streaming responses). Config: `playwright.config.ts`.

## Architecture

```
Frontend (Next.js) ──▶ LangGraph SDK ──▶ LangGraph Backend (lead_agent)
                                              ├── Sub-Agents
                                              └── Tools & Skills
```

The frontend is a stateful chat application. Users create **threads** (conversations), send messages, set thread-scoped `/goal` completion conditions, and receive streamed AI responses. The backend orchestrates agents that can produce **todos** and goal state updates.

### Source Layout (`src/`)

- **`app/`** Next.js App Router. Routes include `/` (redirects to `/workspace/workflows` in the normal build; the marketing landing page is only served by the static website build), `/workspace/workflows` (workflow list/editor), `/workspace/workbenches` (saved project workbenches and execution board), `/workspace/capability-groups` (capability-group management), `/workspace/model-profiles` (the managed middle layer between AI nodes and actual LLMs), `/[lang]/docs/…`, and `/api/…` route handlers (e.g. `/api/memory`). The Lead Agent has no standalone route.
- **`components/`** — React components:
  - `ui/` — Shadcn UI primitives (auto-generated, ESLint-ignored)
  - `ai-elements/` — Vercel AI SDK elements (auto-generated, ESLint-ignored)
  - `workspace/` Workspace chrome and panels (Lead Agent, execution monitor, settings, workflows)
  - `landing/` — Landing page sections
  - `docs/` — Docs / MDX rendering components
- **`core/`** Business logic, the heart of the app. Domains include `threads/` (creation, streaming, state), `api/` (LangGraph client singleton), `agents/` (custom-agent API used by workflow nodes), `auth/` (single-user identity shim; `AuthProvider` exposes the static default user and there is no login/session), `i18n/` (en-US, zh-CN), `settings/`, `memory/`, `skills/`, `messages/`, `mcp/`, `model-profiles/`, `models/`, `voice-input/` (browser speech-recognition helpers), `tasks/`, `todos/`, `tools/`, `workspace-changes/` (run-scoped changed-file summaries and diff fetching), `config/`, `notification/`, plus rendering helpers (`rehype/`, `streamdown/`) and `utils/`.
- **`hooks/`** — Shared React hooks
- **`lib/`** — Utilities (`cn()` from clsx + tailwind-merge)
- **`content/`** — MDX content (blog posts, docs) rendered by the app
- **`styles/`** — Global CSS with Tailwind v4 `@import` syntax and CSS variables for theming
- **`typings/`** — Ambient TypeScript declarations
- Root files: `env.js` (env validation), `mdx-components.ts` (MDX component map)

### Data Flow

1. Optional composer helpers such as `core/voice-input` can transcribe browser microphone input into the local draft; confirmed user input then flows to thread hooks (`core/threads/hooks.ts`) → LangGraph SDK streaming
2. Stream events update thread state (messages, todos, goal). The main thread stream uses the LangGraph SDK's `throttle: true` mode so updates received in the same macrotask coalesce before React is notified; do not replace it with a numeric delay without validating the SDK's trailing-debounce behavior on a continuous stream.
3. `useThreadHistory` loads persisted conversation pages from `GET /api/threads/{id}/messages/page`, preserving the backend's thread-global event `seq`; rendering overlays checkpoint/live copies at their matching canonical identities (a summarized checkpoint may contain a protected early input plus a recent tail). Context-compaction rescue diffs every retained visible identity rather than slicing at the first anchor, and keeps a run-scoped ledger of committed visible messages so replacement updates and repeated rolling checkpoint windows cannot erase an already displayed step. The resolver suppresses checkpoint/transient prefixes whose canonical position is still behind an unloaded cursor page instead of collapsing that unknown gap before a recent anchor, then adds optimistic messages without timestamp re-sorting. History invalidation preserves already-loaded pages so their established ordering positions are not discarded. Dynamic context re-keys the submitted user message from `X` to `X__user`; UI identity matching normalizes that reserved suffix only for human messages so the submitted frame and checkpoint replacement remain one visible turn. A locally submitted turn also records its pre-submit identity baseline: if `messages-tuple` publishes new AI/tool steps before `values` publishes that turn's human message, render ordering moves only those non-baseline visible steps behind the new human while leaving history, hidden controls, and reconnected runs untouched. Keep that local order anchor through finish, stop, and stream error because the SDK's settled frame can retain transient event order; replace it on the next local submit and clear it on thread switch or replay-gap recovery.
4. Stop actions call the LangGraph SDK stream stop path; `core/threads/hooks.ts` invalidates current-thread, thread-history, token-usage, and sidebar/search caches immediately and schedules one follow-up refetch because SDK stop may finish via abort + fire-and-forget cancel before backend title finalization commits
5. TanStack Query manages server state; localStorage stores user settings. The
   Settings > Tools MCP switch calls the targeted `PATCH /api/mcp/config`
   mutation, disables switches until that mutation's success refetch completes,
   displays the backend error `detail` through a toast, and invalidates
   `["mcpConfig"]` only after success.
6. Components subscribe to thread state and render updates

The Lead Agent panel header's context-window control is intentionally persistent: while `context_usage` is unavailable, `ContextUsageBadge` renders a gauge placeholder rather than unmounting; once data arrives, the same position shows the percentage. `useThreadTokenUsage` retains placeholder data only when the response `thread_id` still matches the active panel thread, so same-thread refetches do not flicker and switching conversations never displays the previous chat's usage.

Run duration is run-scoped UI metadata even though the compatibility field `additional_kwargs.turn_duration` is repeated on historical AI messages. `core/messages/run-duration.ts` folds those copies into one display anchored after the run's last visible message group. `MessageList` owns the temporary client-side duration for a just-completed live turn until authoritative history arrives. The duration is total run wall-clock time, not per-message reasoning time; reasoning disclosure and run activity/duration are rendered separately.

The workspace-change card follows the same rule: it is resolved from `(threadId, runId)` alone, so every AI message of a run would render an identical copy. A run ends in more than one terminal assistant bubble whenever the model emits answer text that never gains a tool call, so `core/messages/workspace-change-anchor.ts` picks the run's last assistant bubble and `MessageListItem` renders the badge only for that anchor (#4555). Any future run-scoped display belongs in the same place — do not hang one off every message. The two anchor helpers deliberately differ in which group types they accept as a run's last position, because an anchor is only useful where the display is actually rendered: run duration is emitted by `MessageList` around every group, so it accepts any type, while the workspace-change card comes from `MessageListItem` and so restricts to `assistant`. Keep a new helper's candidate set matched to its own render site rather than unifying them.

Composer drafts are tab-scoped browser state. `core/threads/composer-draft.ts` stores only text plus the selected slash-skill name in `sessionStorage`, keyed by user, agent, and logical conversation scope. New Lead Agent conversations pass the stable scope `"new"` because their runtime `threadId` is a fresh UUID on every reload; established conversations use their real thread ID. `InputBox` waits for enabled skills before restoring a skill chip, degrades a missing/disabled skill back to editable slash text, and clears the stored draft through `SendMessageOptions.onSent` only after the send passes the in-flight guard. Attachments, voice state, and polish undo state are not persisted.

Single-user deployment: there is no login UI or session. `core/auth/AuthProvider` holds the static default user (`src/core/auth/static-user.ts`), `core/auth/server.ts::getServerSideUser()` always returns that same user, and no tokens/cookies are stored by the frontend.

`/goal` and `/compact` are built-in composer commands, not skill activations. `src/components/workspace/input-box.tsx` intercepts `/goal`, `/goal clear`, and `/goal <condition>` before normal chat submission, calling Gateway `GET/PUT/DELETE /api/threads/{thread_id}/goal`. Setting `/goal <condition>` also submits the condition text as the next user task so the agent starts running immediately; status and clear do not start a run. Goal and compact requests are tied to the current `threadId` with an `AbortController`, so switching threads or unmounting the composer aborts in-flight requests and stale responses cannot update the new thread's composer state. The Lead Agent panel renders `GoalStatus` above the composer from `AgentThreadState.goal`, with local optimistic state until the next stream `values` update arrives. `/compact` calls `POST /api/threads/{thread_id}/compact` to summarize older active context while leaving the full visible chat history intact; it is skipped on new/empty threads and blocked server-side while a run is in flight. Thread rename uses the same serialized state-write route; the rename dialog stays open and surfaces the server error when an active run returns 409.

The `/` skill list stays reachable after a skill is selected: typing `/` in the editable text beside the chip reopens it, and picking an entry swaps the chip rather than adding a second one, because the wire format carries exactly one leading `/skill`. That list offers skills only while a chip is selected — a builtin command owns the whole composer line, so `/goal` behind a selected skill would submit as chat text instead of running the command. The trigger itself is unchanged: a slash only opens the list at the start of the input (`getLeadingSlashSkillQuery`), pinned by `tests/e2e/chat.spec.ts`.

Human input requests are a structured message protocol layered on normal chat history. The backend writes request payloads to `ToolMessage.artifact.human_input`, `src/core/messages/human-input.ts` owns the runtime validators/types, and `src/components/workspace/messages/human-input-card.tsx` renders the reusable card. The protocol is versioned on the request side only: v1 covers `free_text` / `choice_with_other`, and v2 adds `form` (typed fields — text/textarea/number/select/multi_select/checkbox/date — with required-field validation in the card). Replies deliberately stay on the v1 response protocol: the form card submits a `response_kind: "text"` reply whose value is the human-readable summary plus one JSON block keyed by stable field names (`buildHumanInputFormSubmissionValue` — the readable part alone is ambiguous because labels/values may contain the separators), so the model can reconstruct the submitted mapping without a structured response kind. The validators reject unknown versions/modes (and field names colliding with JS `Object.prototype` members) so future protocol bumps degrade to the plain-text ToolMessage fallback rather than rendering a broken card. Form values are read through own-property access only (`readHumanInputFormValue`); select fields stay controlled from their empty-string placeholder state through selection; checkbox fields are native `<input type="checkbox">` controls seeded to an explicit `false` (`buildInitialHumanInputFormValues`) so an untouched checkbox submits as "no" while a `required` checkbox keeps must-agree semantics (no HTML `required` attribute — native constraint validation would intercept the custom submit path), and form controls carry label/`htmlFor`, `aria-required` plus a visually-hidden localized "required" marker, and `aria-invalid`/error associations whose error node stays mounted while any field is still invalid. Composer-bypass closure: `deriveHumanInputThreadState` treats a visible plain human message as answering the latest unanswered request opened before it (only the latest — nothing guarantees a single outstanding request across runs, and closing all would silently swallow older decisions; an older request left open simply becomes the active card again). This lets current users bypass a structured form through the normal composer and preserves compatibility with old v1-only frontends that degrade a v2 request to plain text. `MessageList` owns answered/latest/pending state for visible cards, but derives answered responses from raw `thread.messages` because replies are hidden; pending cards clear when the hidden reply appears, when dispatch is dropped, or when a new `thread.error` reports an async stream failure. Lead Agent card submit callbacks must send a normal human message and put `hide_from_ui: true` plus the response payload in the fourth `sendMessage(..., options)` argument as `options.additionalKwargs`; the third argument remains run context such as `{ agent_name }`. Composer entry points remain enabled while a human-input request is open; a normal visible message intentionally bypasses the card and starts the next run without structured response metadata.

Tool-calling AI messages can contain user-visible text as well as `tool_calls`. `core/messages/utils.ts` keeps these turns in an `assistant:processing` group, and `components/workspace/messages/message-group.tsx` must render the visible text as a processing step instead of treating the message as only tool metadata. This preserves provider text such as error explanations or "trying another approach" notes during tool-heavy runs.
While the current turn is still loading, a content-only AI message after the latest visible human input also stays in that processing group until the turn settles: a provider may append tool-call chunks to the same message later, and classifying it as a final assistant bubble too early makes the text jump into the steps panel. `MessageGroup` therefore renders processing text even before the first tool call arrives.
The same rule applies after an earlier tool call: a later content-only AI message remains visible after the current last tool-call step while streaming, because that message may itself gain another tool call before the turn settles.
Because the same message is rendered by two different components over its lifetime, reasoning must sit above the answer text in both. `MessageListItem` paints the settled bubble's `<Reasoning>` disclosure above its content, so `MessageGroup` puts the trailing reasoning disclosure above the assistant text that follows it and `convertToSteps` emits a message's reasoning step before its content step — otherwise the two swap places the instant the turn settles (#4576). Assistant text emitted _before_ that reasoning keeps its earlier position; only the answer the reasoning produced moves below it.

Edit-and-rerun is deliberately latest-turn-only. `core/messages/utils.ts::getLatestEditableTurn()` exposes a human turn only when the transcript is idle and the most recent visible turn ends in a terminal assistant message. `core/threads/hooks.ts::editAndRegenerateMessage()` calls `POST /api/threads/{id}/runs/edit-regenerate/prepare`, submits the returned replacement message/checkpoint/metadata through the same LangGraph stream path as regenerate, optimistically hides the superseded message ids, and clears the optimistic replacement once the persisted replacement arrives.

``MessageGroup` builds its tool-result lookup once per processing group before converting messages to steps. The lookup preserves the first non-empty result for each tool-call ID, matching the streamed-message display semantics without repeatedly scanning the full group for every tool call.

### Key Patterns

- **Server Components by default**, `"use client"` only for interactive components
- **Static root boundary** — `src/app/layout.tsx` must not read cookies or import
  chat-only KaTeX/Streamdown styles. Auth and workspace layouts own the cookie-derived
  locale provider; docs derive locale from their route, and blog owns its preference
  cookie. Public server routes load one dictionary at a time through
  `core/i18n/translations.ts`; the interactive auth/workspace client provider owns both
  formatter-bearing dictionaries because functions cannot cross the RSC boundary.
  Keep public `/` static and keep rich-content CSS on the routes that render it.
  The normal build's root entry is a routing-layer redirect (`next.config.js`
  `redirects()`) to `/workspace/workflows` so opening the app lands in the
  workspace without rendering the heavy landing page first; only the static
  website build (`NEXT_PUBLIC_STATIC_WEBSITE_ONLY=true`) serves the landing at
  `/`.
- **Thread hooks** (`useThreadStream`, `useSubmitThread`, `useThreads`) are the primary API interface
- **Thread routes** - the Lead Agent has no standalone route; selected threads live in `LeadAgentProvider`. Custom-agent backend records still carry `agent_name`, but there is no custom-agent chat page.
- **LangGraph client** is a singleton obtained via `getAPIClient()` in `core/api/`
- **Run stream options** are sanitized by `core/api/stream-mode.ts`: the Gateway-supported set is `values`, `messages-tuple`, `updates`, `debug`, `tasks`, `checkpoints`, and `custom`; any request containing an unsupported mode throws before HTTP instead of being partially forwarded or silently defaulting to `values`. `streamResumable` is retained by thread hooks only for SDK-side reconnect bookkeeping but stripped before the HTTP request because the Gateway does not accept that request option; actual replay uses the SSE `Last-Event-ID` cursor. Keep this boundary aligned with the backend request schema; `messages` and `events` are not supported and must not be forwarded.
- **SSE replay gaps** are handled in `core/api/api-client.ts`, which wraps both initial and joined run streams because the upstream SDK ignores unknown event names. An id-less backend `gap` control frame clears stale reconnect metadata, emits an internal `stream_replay_gap` custom event, reloads durable thread values, and rejoins after the server-provided retained tail, with up to five recovery rejoins after the original stream (six total stream calls on an all-gap exhaustion path). The wrapper remains a lazy async iterable because the SDK consumes it with `for await`. `core/threads/hooks.ts` clears optimistic/transient/subtask state, invalidates durable history caches, and shows the localized recovery warning; never let a gap fall through as a normal stream finish or cancel the still-running backend run.
- **Streaming Markdown rendering** is owned by `core/streamdown`: Streamdown's `animated` / `isAnimating` API handles incremental word animation, while the shared `streamdownRenderingPlugins` config registers the named code-highlighting and Mermaid plugins required by Streamdown 2.5. Keep wrappers and derived configs wired to that shared object; do not reintroduce a rehype plugin that wraps every word, because reparsing a growing block remounts old words and replays their animation.
- Citation links in message Markdown must derive their `citation:` label from the full `ReactNode` children tree, since Streamdown may provide element or array children during streaming rather than a plain string.
- **Environment validation** uses `@t3-oss/env-nextjs` with Zod schemas (`src/env.js`). Skip with `SKIP_ENV_VALIDATION=1`
- **Subtask step history and runtime metadata** (`core/tasks/`) — the subtask card shows a subagent's full step timeline (#3779): its assistant reasoning turns interleaved with the tools it ran. `Subtask.steps[]` is accumulated live from `task_running` events (appended via `mergeSteps`, not overwritten) and backfilled on expand for historical runs by `fetchSubtaskSteps`, which pages the events endpoint scoped to one task (GET `/runs/{runId}/events?event_types=subagent.step&task_id=…&after_seq=…`) until a short page, so the run-wide limit can't truncate the timeline. `task_started` carries the effective `model_name`; `task_running` carries a cumulative usage snapshot after each completed LLM call. `core/tasks/lifecycle.ts` normalizes these additive events, and `computeNextSubtask` keeps the largest cumulative total so replayed or late SSE frames cannot double-count or roll the folded card backward. Terminal ToolMessage metadata (`subagent_model_name` / `subagent_token_usage`) restores the same values from normal history after reload; no per-card event fetch is needed. `core/tasks/steps.ts` is the pure step model: `messageToStep` (live), `eventsToSteps` (reload), `mergeSteps` (dedup by `message_index`), and `stepsForDisplay` (what the card renders — keeps tool steps + AI steps with text, drops the trailing final-answer AI step when completed since it's shown as `result`). `core/tasks/context.tsx`'s `useUpdateSubtask` applies updates against a `tasksRef` mirroring the latest state (not a closure snapshot), so a late-resolving `fetchSubtaskSteps` backfill merges into current state instead of clobbering SSE steps or sibling subtasks that arrived meanwhile. The owning `run_id` is carried onto history content messages in `buildVisibleHistoryMessages` so the card can resolve the events endpoint.

### Interaction Ownership

- `src/components/workspace/workflow-monitor/global-workflow-monitor.tsx` owns the persistent right-hand execution monitor. It is mounted by `WorkspaceShell` in the workspace layout, not by a page, so switching left-sidebar destinations never unmounts it. It polls `/api/workflow-monitor/runs` for active/waiting-human runs and `/api/human-tasks?status=pending` for the bottom human-decision section. It is display-only for execution (launch/step/cancel stay on a workbench); resolving review/task/debug-pause rows is allowed because those suspend a run. Collapsed/expanded state and width persist in local storage.
- `src/components/workspace/lead-agent/lead-agent-context.tsx` + `lead-agent-panel.tsx` own the persistent bottom Lead Agent. It is mounted by `WorkspaceShell`, not by a page, so sidebar navigation never unmounts the conversation. The panel holds the active thread id, survives collapse without unmounting the stream, exposes the history dialog, persists collapsed/height state, and uses model profiles instead of raw model names. `SkillMenu` in the composer toolbar selects one enabled skill for the thread and sends it as `context.active_skills`; the Lead Agent injects that skill before the next run. `ResourceUndoControl` lists `GET /api/threads/{id}/resource-changes` and calls the all-or-nothing `POST /undo` endpoint. There is no standalone chat route, history page, custom-agent page, mode menu, preset list, sidecar, artifact panel, or browser panel.
- `src/components/workspace/workbenches/workbench-board.tsx` owns the execution surface: saved member cards, Run / Step run / Cancel, run status from the monitor endpoint, and the editor hand-off. `workbench-list.tsx` owns workbench CRUD. Launch always calls the backend workbench endpoint, which forces `on_disconnect="continue"`; a workbench card may start multiple runs, and the board only shows runs whose `workbench_id` matches.
- `src/app/workspace/model-profiles/page.tsx` + `src/components/workspace/model-profiles/model-profile-list.tsx` own model-profile CRUD: list resolved target health/reference counts, create/edit (name, display name, description, actual model from `GET /api/models`, enabled), and delete guarded by backend references. `src/core/model-profiles/` owns the API hooks. `workflow-node-form.tsx` exposes the profile picker in the AI node form; `params.model_profile` stores the stable profile id.
- `src/components/workspace/workflows/workflow-node.tsx` owns the inline node editor: there is no properties panel. Every card renders its fixed parameter form (schema in `src/core/workflows/canvas/node-property-schema.ts`) or a dedicated form (`data:schema` uses the row-based AI Result Schema editor); selection only controls the resizer, ring, and prompt-preview activity. Header actions own node deletion. `NodeResizer` stores dimensions in `metadata.canvas.sizes`; card content is a scrollable flex body and port/form layout uses container queries. The old arbitrary `params` key/value editor was removed: keys outside the per-type schema are deleted on load/save.
- `src/components/workspace/workflows/workflow-node-form.tsx` owns the LLM Agent form: agent picker and model profile above the Prompt composition panel. There is no instruction editor, autonomy, context policy, memory, retrieval, model policy, merge, or rollback field. `template_prompt` is the only task input for a fresh turn; `continue_prompt` is the continue-mode input; `input_schema` and `output_schema` both arrive from `data:schema`. `workflow-schema-form.tsx` is the dedicated row editor for the shared AI Result Schema (fixed common fields plus user custom fields); `core/workflows/canvas/ai-schema.ts` owns its normalization/validation/reference list. `workflow-ai-prompt-composition.tsx` auto-previews the current (possibly unsaved) definition through `POST /prompt-preview` and renders read-only source rows including capability rules, skill descriptions, schema contract, input/output schema, and the runtime `template_prompt` port.
- `src/components/workspace/workflows/workflow-toolbar.tsx` is save/back only. The editor deliberately has **no** Run/Stop/Step controls: every manual run is launched from a workbench card, and single-step is a workbench launch option (`debug_step: true`). Saving is allowed while a run is active because the run keeps its admission snapshot; a dirty document marks the back link and intercepts navigation into a save/discard/cancel dialog. The back target is the workbench when the URL carries `?workbench=`, otherwise the workflow directory.
- `src/components/workspace/workflows/workflow-canvas.tsx` owns canvas creation/editing affordances: double-clicking empty space opens the searchable, category-grouped node catalog (`workflow-node-catalog-dialog.tsx`) at that flow position, and node/pane context menus copy, cut, and paste selections (`src/core/workflows/canvas/clipboard.ts`). There is no persistent palette pane. `workflow-context-menu.tsx` is cursor-anchored; paste preserves internal edges and remaps all node/edge ids. A target input port accepts only one incoming edge; `flow:end` and `flow:loop` are the deliberate exceptions (terminal sink and loop back-edge). The shared `ai-elements/canvas.tsx` wrapper leaves wheel input as zoom (`panOnScroll={false}`); panning stays on middle-button drag. Node instance labels are canvas-only: `workflow-node.tsx` shows the editable custom name above the fixed catalog name, and the override round-trips through `metadata.canvas.labels` (never the definition `Node`), and explicit card dimensions round-trip through `metadata.canvas.sizes`. Subworkflow editors are reached through a URL-encoded breadcrumb trail (`core/workflows/trail.ts`); a subworkflow node defaults to a shared template reference (global save, gray border), while `params.subworkflow.save_mode: "local"` stores an inline snapshot edited through the parent draft (local save, amber border). Local snapshots are resolved/saved by `core/workflows/embedded-subworkflow.ts`; root contexts flush their draft before navigation so the child can read it synchronously.
- `src/components/workspace/workflows/workflow-list.tsx` owns the workflow directory as an arbitrary-depth folder tree. `src/core/workflows/folder-tree.ts` is the pure tree/path/option builder; folders are created/renamed/deleted through the folder API and workflows are moved with `folder_id`. The list intentionally shows no run-status badge. The editor header renders the root-to-folder breadcrumb via `workflowFolderPath`.
- `src/core/workflows/editor-session.ts` owns the tab-scoped workflow workspace state (`sessionStorage`): the last location (directory vs. a workflow id) and the dirty canvas draft per workflow. `WorkflowEditorProvider` restores a dirty draft ahead of the saved record, debounces writes while editing, and clears the draft on save/discard; the sidebar Workflows entry resolves the remembered location instead of always opening the directory.
- `src/hooks/use-persisted-toggle.ts` persists panel disclosure state in `localStorage` (Lead Agent, global workflow monitor, capability-group rows and folder tree), so the user's expanded/collapsed layout survives reloads.
- `src/app/workspace/capability-groups/page.tsx` renders each category as an arbitrary-depth folder tree built by `src/core/capability-groups/tree.ts`; built-in categories keep their curated order, while any extra top-level directory becomes its own category (label falls back to the raw directory name). Each group row also has a root-folder reveal button (`PATH "."` on the same `/reveal` route).
- `src/core/workflows/human-tasks.ts` owns the client half of the human-task protocol (N14ae debug controls + N14aj submission forms). A step suspension is a pending `human_tasks` row, so the panel resolves it with the existing submit/skip routes rather than a second suspension protocol: `continueDebugPause` submits `{acknowledge: true}` — deliberately non-empty, since LangGraph treats a _falsy_ `Command(resume=...)` payload as "not resumed" and would suspend the node again — and `skipHumanTask` resumes with the node's outputs unset. `pendingDebugPauses` / `pendingHumanTasks` are the two pure selectors (debug pauses vs. submission forms), each pinning the panel's own run first but **not** exclusively, because a resume admits a _new_ run id, so a run-scoped list would make a stepped run unreachable after its first resume. `humanTaskFields` derives the form's fields from the row's own `output_spec` + `validation_rules` — what the backend validator checks and nothing else — and a declared port type wins over an `enum` rule, because a review's `decision` is a **bool** port whose `enum: [true, false]` constrains the _choice_ (a select would submit the string `"true"`). `serializeHumanTaskDrafts` is all-or-nothing and leaves booleans unset until picked: an untouched review must never submit the `false` that _rejects_ the result.
- `src/components/workspace/workflows/workflow-human-task-form.tsx` owns the generic submission form (N14aj): one control per declared field (bool → explicit true/false buttons narrowed to the rule's allowed values, number, JSON, enum select, text), the review-specific card is rendered by `workflow-review-form.tsx`, inline local errors before any request, and the backend's own rejection verbatim. `src/components/workspace/workflow-monitor/global-workflow-monitor.tsx` owns the §25 single-step pause controls and pending human-task forms in its bottom section: **Continue**/**Skip** per pending debug pause, and the generic/review submission form for every other pending `task`/`review` row. A failed list read renders an explicit retry line instead of silently claiming there is nothing waiting, and after either action it re-reads the list because the resumed run is server-side.
- `src/components/workspace/messages/message-list.tsx` owns human-input card answered/latest/pending gating; entry pages only translate a submitted card response into `sendMessage` calls.
- `src/core/threads/hooks.ts` owns pre-submit upload state and thread submission.

## Code Style

- **Imports**: Enforced ordering (builtin → external → internal → parent → sibling), alphabetized, newlines between groups. Use inline type imports: `import { type Foo }`.
- **Unused variables**: Prefix with `_`.
- **Class names**: Use `cn()` from `@/lib/utils` for conditional Tailwind classes.
- **Path alias**: `@/*` maps to `src/*`.
- **Components**: `ui/` and `ai-elements/` are generated from registries (Shadcn, MagicUI, React Bits, Vercel AI SDK) — don't manually edit these.

## Environment

Backend API URLs are optional; an nginx proxy is used by default:

```
NEXT_PUBLIC_BACKEND_BASE_URL=http://localhost:8001
NEXT_PUBLIC_LANGGRAPH_BASE_URL=http://localhost:8001/api
```

Leave these unset for the standard `make dev` / Docker flow, where nginx serves the public `/api/langgraph/*` prefix and rewrites it to Gateway's native `/api/*` routes.

To reach a dev server on anything other than localhost — a LAN address, or a proxied hostname — list the host in `DEER_FLOW_DEV_ALLOWED_ORIGINS` (comma-separated; a full URL is reduced to its host). It feeds Next's `allowedDevOrigins`, which gates `/_next/*`, fonts, and HMR. Without it those requests get a 403 and the page renders server-side but never hydrates, so nothing on it — including the login form — responds. Development only; production builds ignore it.

## Resources

- [LangGraph Documentation](https://langchain-ai.github.io/langgraph/)
- [LangChain Core Concepts](https://js.langchain.com/docs/concepts)
- [TanStack Query Documentation](https://tanstack.com/query/latest)
- [Next.js App Router](https://nextjs.org/docs/app)

## Contributing

When adding features:

1. Follow the established `src/` structure
2. Add TypeScript types and proper error handling
3. Write unit tests under `tests/unit/` (`pnpm test`) and E2E tests under `tests/e2e/` (`pnpm test:e2e`)
4. Run `pnpm check` before committing
5. Update this `AGENTS.md` when architecture, commands, or conventions change

Route asset budgets are enforced with `pnpm perf:check`. The command measures
`/login` from a normal production build, then builds in static-demo mode for the
fixture-backed workspace routes. It starts the production server on temporary local
ports, measures the unique JavaScript and CSS files referenced by representative
routes, writes the detailed result to `.next/performance-results.json`, and compares
totals with `performance-budgets.json`. Fix route ownership or split points when a
budget fails; do not raise a ceiling without documenting and reviewing the measured
regression.
