import asyncio
import logging
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.gateway.browser_capability import ensure_browser_runtime_available
from app.gateway.config import get_gateway_config
from app.gateway.cors import CORS_EXPOSED_HEADERS, get_configured_cors_origins
from app.gateway.deps import langgraph_runtime
from app.gateway.routers import (
    agents,
    apps,
    artifacts,
    assistants_compat,
    browser,
    console,
    environment,
    features,
    human_task_routes,
    mcp,
    memory,
    models,
    runs,
    scheduled_tasks,
    skills,
    thread_runs,
    threads,
    uploads,
    workflow_routes,
)
from app.gateway.trace_middleware import TraceMiddleware, resolve_trace_enabled
from deerflow.config import app_config as deerflow_app_config
from deerflow.logging_config import DEFAULT_LOG_DATE_FORMAT, DEFAULT_LOG_FORMAT, configure_logging
from deerflow.tracing.monocle import setup_monocle_tracing_if_enabled
from deerflow.uploads.manager import cleanup_stale_upload_staging_files

AppConfig = deerflow_app_config.AppConfig
get_app_config = deerflow_app_config.get_app_config

# Default logging; lifespan overrides from config.yaml log_level.
logging.basicConfig(
    level=logging.INFO,
    format=DEFAULT_LOG_FORMAT,
    datefmt=DEFAULT_LOG_DATE_FORMAT,
)

logger = logging.getLogger(__name__)

# Upper bound (seconds) each lifespan shutdown hook is allowed to run.
# Bounds worker exit time so uvicorn's reload supervisor does not keep
# firing signals into a worker that is stuck waiting for shutdown cleanup.
_SHUTDOWN_HOOK_TIMEOUT_SECONDS = 5.0

# The retrieval index is derived state, so shutdown only waits briefly for its
# startup rebuild. The canonical memory flush keeps its full configured budget.
_RETRIEVAL_WARM_SHUTDOWN_TIMEOUT_SECONDS = 1.0


async def _warm_memory_retrieval(manager) -> None:
    """Rebuild the derived retrieval index without delaying Gateway readiness."""
    try:
        rebuilt = await asyncio.to_thread(manager.warm_retrieval)
        if rebuilt:
            logger.info("Memory retrieval index rebuilt successfully")
        else:
            logger.warning("Memory retrieval index rebuild failed; scoped searches will retry lazily")
    except Exception:
        logger.warning("Memory retrieval index rebuild skipped", exc_info=True)


def _database_dir(config: AppConfig) -> str | None:
    """The SQLite directory, or ``None`` when the backend keeps no database file."""
    database = getattr(config, "database", None)
    if database is None or getattr(database, "backend", None) != "sqlite":
        return None
    try:
        return str(Path(database.sqlite_path).parent)
    except Exception:  # pragma: no cover - defensive; a bad DB path must not break startup
        return None


def _bootstrap_environment(config: AppConfig) -> None:
    """Ensure the N11 data layout and report the environment once (blocking).

    Runs on a worker thread from the lifespan.  Directory creation is fatal on
    failure (the application owns those paths); requirement probing never is,
    unless the operator opted into ``apps.environment.require_on_load``.

    Sections are read defensively: this hook is a *diagnostic*, and a diagnostic
    must not be able to keep the Gateway from starting.  A minimal or partial
    configuration therefore probes with ``EnvironmentConfig`` defaults instead of
    raising; a real ``AppConfig`` always carries the section.
    """
    from deerflow.apps.registry import AppRegistry
    from deerflow.config.apps_config import EnvironmentConfig
    from deerflow.config.paths import get_paths
    from deerflow.environment.report import build_environment_report
    from deerflow.environment.requirements import validate_environment

    apps_config = getattr(config, "apps", None)
    environment_config = getattr(apps_config, "environment", None) or EnvironmentConfig()
    memory_enabled = bool(getattr(getattr(config, "memory", None), "enabled", True))
    paths = get_paths()
    created = paths.ensure_data_dirs(memory_enabled=memory_enabled, database_dir=_database_dir(config))
    logger.debug("Ensured %d data director(ies)", len(created))

    if not environment_config.enabled:
        logger.debug("Environment probing disabled (apps.environment.enabled=false)")
        return

    requirement_status = validate_environment(
        registry=AppRegistry.from_config(apps_config) if apps_config is not None else None,
        skills=None,
        enabled=True,
        timeout=environment_config.probe_timeout_seconds,
        cache_seconds=environment_config.cache_seconds,
        require_on_load=environment_config.require_on_load,
    )
    report = build_environment_report(
        enabled=True,
        requirement_status=requirement_status,
        data_dir_statuses=paths.check_data_dirs(memory_enabled=memory_enabled, database_dir=_database_dir(config)),
        require_on_load=environment_config.require_on_load,
    )

    problems = report.blocking_problems
    if report.overall != "ok":
        for problem in problems:
            logger.warning("Environment problem: %s", problem)
        if report.overall == "degraded":
            logger.info("Environment report: some requirements are unresolved (unknown) but nothing required is broken")

    if environment_config.require_on_load and problems:
        raise RuntimeError("Environment requirements failed and apps.environment.require_on_load is set: " + "; ".join(problems))


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """Application lifespan handler."""

    # Load config and check necessary environment variables at startup.
    # `startup_config` is a local snapshot used only for one-shot bootstrap
    # work (logging level, langgraph_runtime engines, channels). Request-time
    # config resolution always routes through `get_app_config()` in
    # `app/gateway/deps.py::get_config()` so `config.yaml` edits become
    # visible without a process restart. We deliberately do NOT cache this
    # snapshot on `app.state` to keep that contract enforceable.
    try:
        startup_config = get_app_config()
        configure_logging(startup_config)
        ensure_browser_runtime_available(startup_config)
        logger.info("Configuration loaded successfully")
    except Exception as e:
        error_msg = f"Failed to load configuration during gateway startup: {e}"
        logger.exception(error_msg)
        raise RuntimeError(error_msg) from e
    config = get_gateway_config()
    logger.info(f"Starting API Gateway on {config.host}:{config.port}")

    from deerflow.skills.projection import ensure_public_skill_projection

    public_projection_ready = await asyncio.to_thread(ensure_public_skill_projection, app_config=startup_config)
    if public_projection_ready:
        logger.info("Ensured the public skill projection; user projections repair lazily on sandbox acquire")

    # N11 (§22): ensure the canonical data-directory layout exists and report the
    # environment once.  Probing is read-only and best-effort, so a failing
    # requirement is normally a diagnostic, not a failure — but
    # `apps.environment.require_on_load` upgrades a definitively failed required
    # item into a refusal to serve, for deployments that must not start on an
    # unprepared machine.  A directory that cannot be created is always fatal:
    # the application owns those paths and cannot work correctly without them.
    await asyncio.to_thread(_bootstrap_environment, startup_config)

    # Agent observability (Monocle). Off by default; enabled with
    # MONOCLE_TRACING. Initialized here at startup — not at import time — so a
    # plain `import deerflow.agents` never installs a process-global tracer.
    # Unlike LangSmith/Langfuse, whose validation failures abort the agent run,
    # a bad Monocle config only logs: the Gateway keeps serving without tracing.
    try:
        setup_monocle_tracing_if_enabled()
    except Exception:  # observability must never break startup
        logger.exception("Monocle tracing setup failed; continuing without it")

    # Rebuild the derived memory retrieval index in the background. Scoped
    # searches remain correct while this runs because DeerMem lazily rebuilds
    # the requested scope when the full warm-up has not completed yet.
    retrieval_warm_task: asyncio.Task[None] | None = None
    try:
        from deerflow.agents.memory import get_memory_manager

        if startup_config.memory.enabled:
            manager = await asyncio.to_thread(get_memory_manager)
            warm_retrieval = getattr(manager, "warm_retrieval", None)
            if callable(warm_retrieval):
                retrieval_warm_task = asyncio.create_task(
                    _warm_memory_retrieval(manager),
                    name="memory-retrieval-warm-up",
                )
        else:
            logger.info("Memory is disabled; skipping retrieval index rebuild")
    except Exception:
        logger.warning("Memory retrieval index rebuild skipped", exc_info=True)

    # Pre-warm tiktoken encoding cache so the first memory-injection request
    # never blocks on the BPE data download (which hits an OpenAI/Azure URL
    # that may be unreachable in restricted networks — see issue #3402).
    # Warm-up runs via the manager's `warm()` tier-3 hook. DeerMem.warm re-checks
    # token_counting=="char" and returns early, so char-mode backends never touch
    # tiktoken (avoids even the 5s probe in network-restricted deployments - see
    # issue #3429). A backend with nothing to warm (e.g. noop) returns None from
    # the base default -- log "skipping" instead of the misleading "warmed
    # successfully" so the log reflects what actually happened.
    try:
        from deerflow.agents.memory import get_memory_manager

        manager = await asyncio.to_thread(get_memory_manager)
        warmed = await asyncio.wait_for(
            asyncio.to_thread(manager.warm),
            timeout=5,
        )
        if warmed is None:
            logger.info("Memory backend %s has nothing to warm; skipping tiktoken warm-up", type(manager).__name__)
        elif warmed:
            logger.info("tiktoken encoding cache warmed successfully")
        else:
            logger.warning("tiktoken encoding cache warm-up failed; token counting will use character-based fallback until tiktoken loads successfully")
    except TimeoutError:
        logger.warning("tiktoken encoding cache warm-up timed out; token counting will use character-based fallback until tiktoken loads successfully")
    except Exception:
        logger.warning("tiktoken warm-up skipped", exc_info=True)

    try:
        removed_upload_staging_files = await asyncio.to_thread(cleanup_stale_upload_staging_files)
        if removed_upload_staging_files:
            logger.info("Removed %d stale upload staging file(s)", removed_upload_staging_files)
    except Exception:
        logger.warning("Upload staging file cleanup skipped", exc_info=True)

    # Initialize LangGraph runtime components (StreamBridge, RunManager, checkpointer, store)
    async with langgraph_runtime(app, startup_config):
        logger.info("LangGraph runtime initialised")

        try:
            from app.gateway.services import launch_scheduled_thread_run, launch_scheduled_workflow_run
            from app.scheduler import ScheduledTaskService
            from app.scheduler.probe import TriggerProbe
            from deerflow.persistence.engine import get_session_factory

            if getattr(app.state, "scheduled_task_repo", None) is not None and getattr(app.state, "scheduled_task_run_repo", None) is not None:
                scheduled_task_service = ScheduledTaskService(
                    task_repo=app.state.scheduled_task_repo,
                    task_run_repo=app.state.scheduled_task_run_repo,
                    launch_run=lambda **kwargs: launch_scheduled_thread_run(app=app, **kwargs),
                    launch_workflow=lambda **kwargs: launch_scheduled_workflow_run(app=app, **kwargs),
                    trigger_probe=TriggerProbe(
                        session_factory=get_session_factory(),
                        instance_repo=getattr(app.state, "app_instance_repo", None),
                    ),
                    poll_interval_seconds=startup_config.scheduler.poll_interval_seconds,
                    lease_seconds=startup_config.scheduler.lease_seconds,
                    max_concurrent_runs=startup_config.scheduler.max_concurrent_runs,
                    retry_backoff_seconds=startup_config.scheduler.retry_backoff_seconds,
                    max_retry_backoff_seconds=startup_config.scheduler.max_retry_backoff_seconds,
                )
                app.state.scheduled_task_service = scheduled_task_service
                if startup_config.scheduler.enabled:
                    await scheduled_task_service.start()
        except Exception:
            logger.exception("Failed to initialize scheduled task service")

        try:
            from app.mcp_tasks import McpTaskService
            from deerflow.mcp.tasks import McpTaskDriverRegistry

            if getattr(app.state, "mcp_task_repo", None) is not None:
                mcp_task_drivers = McpTaskDriverRegistry()
                mcp_task_service = McpTaskService(
                    repository=app.state.mcp_task_repo,
                    drivers=mcp_task_drivers,
                    poll_interval_seconds=startup_config.mcp_tasks.poll_interval_seconds,
                    lease_seconds=startup_config.mcp_tasks.lease_seconds,
                    max_concurrent_polls=startup_config.mcp_tasks.max_concurrent_polls,
                )
                app.state.mcp_task_drivers = mcp_task_drivers
                app.state.mcp_task_service = mcp_task_service
                if startup_config.mcp_tasks.enabled:
                    await mcp_task_service.start()
        except Exception:
            logger.exception("Failed to initialize MCP task service")

        yield

        if getattr(app.state, "scheduled_task_service", None) is not None:
            try:
                await app.state.scheduled_task_service.stop()
            except Exception:
                logger.exception("Failed to stop scheduled task service")

        if getattr(app.state, "mcp_task_service", None) is not None:
            try:
                await app.state.mcp_task_service.stop()
            except Exception:
                logger.exception("Failed to stop MCP task service")

        try:
            from deerflow.community.browser_automation import get_browser_session_manager

            closed = await asyncio.wait_for(
                get_browser_session_manager().close_all_sessions(),
                timeout=_SHUTDOWN_HOOK_TIMEOUT_SECONDS,
            )
            if closed:
                logger.info("Closed %d browser session(s)", closed)
        except TimeoutError:
            logger.warning(
                "Browser session shutdown exceeded %.1fs; proceeding with worker exit.",
                _SHUTDOWN_HOOK_TIMEOUT_SECONDS,
            )
        except Exception:
            logger.exception("Failed to close browser sessions")

        # Drain the memory backend's pending-update buffer before the worker
        # exits (best-effort, bounded). IM channels and the scheduler are
        # already stopped above, so no new IM/scheduler updates arrive during
        # the drain; the LangGraph runtime / in-flight HTTP requests can still
        # complete memory enqueues in a narrow window, but anything added after
        # the drain copies the buffer only resets the debounce Timer
        # (best-effort, same as today).
        #
        # No host-level pending/processing guard: ``shutdown_flush``
        # short-circuits on a truly idle buffer (returns True immediately), so
        # calling it unconditionally is cheap and keeps the in-flight-worker
        # race entirely inside the backend (where the buffer lives) -- the host
        # cannot "forget" that case the way a ``pending_count > 0``-only guard
        # would (review #6 on the original PR).
        #
        # K8s caveat: ``shutdown_flush_timeout_seconds`` must fit inside the
        # pod's ``terminationGracePeriodSeconds`` (channel stop + browser
        # session close + the brief retrieval-warm wait + this drain + buffer),
        # set on the gateway Helm deployment -- or K8s SIGKILLs the drain
        # mid-flight and the loss this is fixing is silently re-introduced.
        # The retrieval index is derived from canonical memory files, so its
        # wait is independently capped and never consumes the flush budget.
        retrieval_warm_finished = True
        if retrieval_warm_task is not None and not retrieval_warm_task.done():
            try:
                await asyncio.wait_for(
                    asyncio.shield(retrieval_warm_task),
                    timeout=min(
                        _RETRIEVAL_WARM_SHUTDOWN_TIMEOUT_SECONDS,
                        startup_config.memory.shutdown_flush_timeout_seconds,
                    ),
                )
            except TimeoutError:
                retrieval_warm_finished = False
                logger.warning("Memory retrieval index rebuild is still running; leaving its connection open during shutdown")

        manager = None
        try:
            # Memory shutdown runs on a worker thread and can trigger detached
            # system-model callbacks. Stop accepting those callbacks before
            # flushing, while keeping the registered loop alive for awaited
            # task hooks until langgraph_runtime drains runs and subagents.
            from deerflow.extensions.notify import suspend_extension_system_observations

            suspend_extension_system_observations()
        except Exception:
            logger.debug("Failed to suspend extension system observations (non-fatal)", exc_info=True)

        try:
            app_cfg = get_app_config()
            if app_cfg.memory.enabled:
                from deerflow.agents.memory import get_memory_manager

                manager = await asyncio.to_thread(get_memory_manager)
                flush_timeout = app_cfg.memory.shutdown_flush_timeout_seconds
                completed = await asyncio.to_thread(manager.shutdown_flush, flush_timeout)
                if completed:
                    logger.info("Memory queue flush completed within %.1fs", flush_timeout)
                else:
                    logger.warning(
                        "Memory queue flush did not finish within %.1fs; remaining updates may be lost",
                        flush_timeout,
                    )
        except Exception:
            logger.exception("Failed to flush memory queue on shutdown")
        finally:
            close = getattr(manager, "close", None)
            if callable(close) and retrieval_warm_finished:
                try:
                    await asyncio.to_thread(close)
                except Exception:
                    logger.exception("Failed to close memory backend on shutdown")

    logger.info("Shutting down API Gateway")


def create_app() -> FastAPI:
    """Create and configure the FastAPI application.

    Returns:
        Configured FastAPI application instance.
    """
    config = get_gateway_config()
    docs_url = "/docs" if config.enable_docs else None
    redoc_url = "/redoc" if config.enable_docs else None
    openapi_url = "/openapi.json" if config.enable_docs else None

    app = FastAPI(
        title="DeerFlow API Gateway",
        description="""
## DeerFlow API Gateway

API Gateway for DeerFlow - A LangGraph-based AI agent backend with sandbox execution capabilities.

### Features

- **Models Management**: Query and retrieve available AI models
- **MCP Configuration**: Manage Model Context Protocol (MCP) server configurations
- **Memory Management**: Access and manage global memory data for personalized conversations
- **Skills Management**: Query and manage skills and their enabled status
- **Artifacts**: Access thread artifacts and generated files
- **Health Monitoring**: System health check endpoints

### Architecture

LangGraph-compatible requests are routed through nginx to this gateway.
This gateway provides runtime endpoints for agent runs plus custom endpoints for models, MCP configuration, skills, and artifacts.
        """,
        version="0.1.0",
        lifespan=lifespan,
        docs_url=docs_url,
        redoc_url=redoc_url,
        openapi_url=openapi_url,
        openapi_tags=[
            {
                "name": "models",
                "description": "Operations for querying available AI models and their configurations",
            },
            {
                "name": "mcp",
                "description": "Manage Model Context Protocol (MCP) server configurations",
            },
            {
                "name": "memory",
                "description": "Access and manage global memory data for personalized conversations",
            },
            {
                "name": "skills",
                "description": "Manage skills and their configurations",
            },
            {
                "name": "artifacts",
                "description": "Access and download thread artifacts and generated files",
            },
            {
                "name": "uploads",
                "description": "Upload and manage user files for threads",
            },
            {
                "name": "threads",
                "description": "Manage DeerFlow thread-local filesystem data",
            },
            {
                "name": "agents",
                "description": "Create and manage custom agents with per-agent config and prompts",
            },
            {
                "name": "assistants-compat",
                "description": "LangGraph Platform-compatible assistants API (stub)",
            },
            {
                "name": "runs",
                "description": "LangGraph Platform-compatible runs lifecycle (create, stream, cancel)",
            },
            {
                "name": "health",
                "description": "Health check and system status endpoints",
            },
        ],
    )

    # CORS: the unified nginx endpoint is same-origin by default. Split-origin
    # browser clients must opt in with this explicit Gateway allowlist. They also
    # need the run id the Gateway returns in a non-safelisted response header;
    # without exposing it the SDK never reports a created run, so a new thread
    # keeps its placeholder route and every action gated on an established thread
    # stays hidden until the page is reloaded.
    cors_origins = sorted(get_configured_cors_origins())
    if cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=cors_origins,
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
            expose_headers=list(CORS_EXPOSED_HEADERS),
        )

    # Request trace correlation: when logging.enhance.enabled=true, bind one
    # trace id per Gateway HTTP request and write it to response start headers.
    # `logging` is registered as restart-required (see reload_boundary.py) so we
    # snapshot the flag from the startup AppConfig instead of reading live; a
    # runtime toggle would otherwise leave the log formatter (installed once by
    # configure_logging() at lifespan startup) out of sync with the middleware.
    app.add_middleware(TraceMiddleware, enabled=_resolve_trace_enabled_for_app_construction())

    # Python extensions load once while the Gateway app is constructed. Agent
    # middleware builders consume the same immutable set through the process
    # singleton; app.state exposes it to the Gateway runtime.
    from deerflow.extensions import (
        EMPTY_EXTENSIONS,
        ExtensionLoadError,
        initialize_runtime_diagnostics,
        load_extensions,
        set_loaded_extensions,
    )

    # Resolving the configured plugin list is deliberately outside the
    # fail-open guard below: a config.yaml that exists but cannot be parsed or
    # validated is a configuration failure, not an extension failure. Reporting
    # it as the latter would silently drop a `required: true` extension instead
    # of failing the boot. Only an absent config.yaml is tolerated, mirroring
    # _resolve_trace_enabled_for_app_construction() — create_app() runs at
    # import time, and lifespan still performs strict config loading before
    # serving.
    try:
        configured_plugins = get_app_config().plugins
    except FileNotFoundError:
        logger.debug("config.yaml not found while constructing Gateway app; loading no extensions for this app instance")
        configured_plugins = []

    try:
        loaded_extensions, extension_diagnostics = load_extensions(configured_plugins)
    except ExtensionLoadError:
        # `required: true` makes the extension part of the startup contract.
        # Booting without it would silently change configured behaviour.
        raise
    except Exception:
        logger.exception("Extension loading failed; continuing with no extensions")
        loaded_extensions, extension_diagnostics = EMPTY_EXTENSIONS, []
    set_loaded_extensions(loaded_extensions)
    app.state.extensions = loaded_extensions
    app.state.extension_diagnostics = initialize_runtime_diagnostics(extension_diagnostics)

    # Include routers
    # Models API is mounted at /api/models
    app.include_router(models.router)

    # Features API is mounted at /api/features
    app.include_router(features.router)
    app.include_router(apps.router)

    # Environment report (N11) is mounted at /api/environment
    app.include_router(environment.router)

    # Console API (cross-thread observability) is mounted at /api/console
    app.include_router(console.router)

    # MCP API is mounted at /api/mcp
    app.include_router(mcp.router)

    # Memory API is mounted at /api/memory
    app.include_router(memory.router)

    # Skills API is mounted at /api/skills
    app.include_router(skills.router)

    # Artifacts API is mounted at /api/threads/{thread_id}/artifacts
    app.include_router(artifacts.router)

    # Browser API is mounted at /api/threads/{thread_id}/browser
    app.include_router(browser.router)

    # Uploads API is mounted at /api/threads/{thread_id}/uploads
    app.include_router(uploads.router)

    # Thread cleanup API is mounted at /api/threads/{thread_id}
    app.include_router(threads.router)

    # Scheduled tasks API is mounted at /api/scheduled-tasks
    app.include_router(scheduled_tasks.router)

    # Workflow definitions API is mounted at /api/workflows
    app.include_router(workflow_routes.router)

    # Workflow runs API is mounted at /api/workflows/{definition_id}/runs
    from app.gateway.routers import workflow_run_routes

    app.include_router(workflow_run_routes.router)

    # Human tasks API is mounted at /api/human-tasks
    app.include_router(human_task_routes.router)

    # Agents API is mounted at /api/agents
    app.include_router(agents.router)

    # Assistants compatibility API (LangGraph Platform stub)
    app.include_router(assistants_compat.router)

    # Thread Runs API (LangGraph Platform-compatible runs lifecycle)
    app.include_router(thread_runs.router)

    # Stateless Runs API (stream/wait without a pre-existing thread)
    app.include_router(runs.router)

    @app.get("/health", tags=["health"])
    async def health_check() -> dict[str, str]:
        """Health check endpoint.

        Returns:
            Service health status information.
        """
        return {"status": "healthy", "service": "deer-flow-gateway"}

    return app


def _resolve_trace_enabled_for_app_construction() -> bool:
    """Resolve the trace middleware flag without making imports require config.yaml."""
    try:
        return resolve_trace_enabled(get_app_config())
    except FileNotFoundError:
        # Startup lifespan still performs strict config loading before serving.
        logger.debug("config.yaml not found while constructing Gateway app; TraceMiddleware disabled for this app instance")
        return False


# Create app instance for uvicorn
app = create_app()
