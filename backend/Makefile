DEER_FLOW_HOME ?= $(CURDIR)/.deer-flow
DEER_FLOW_HOME := $(abspath $(DEER_FLOW_HOME))
BACKEND_SANDBOX_HOME := $(abspath $(CURDIR)/sandbox)

install:
	uv sync

# Invoke console tools as ``python -m <tool>`` rather than ``uv run <tool>``.
# On Windows, ``uv run uvicorn``/``pytest`` resolve a generated ``.exe``
# trampoline that embeds the venv's absolute python path; if the checkout is
# moved/renamed after the venv was created, that path goes stale and uv fails
# with "uv trampoline failed to canonicalize script path".  ``python -m`` uses
# the interpreter directly and is immune to that.
dev:
	mkdir -p "$(DEER_FLOW_HOME)" "$(BACKEND_SANDBOX_HOME)"
	PYTHONPATH=. PYTHONIOENCODING=utf-8 PYTHONUTF8=1 DEER_FLOW_HOME="$(DEER_FLOW_HOME)" uv run python -m uvicorn app.gateway.app:app --host 0.0.0.0 --port 8001 \
		--reload \
		--reload-include='*.yaml' \
		--reload-include='.env' \
		--reload-exclude='*.pyc' \
		--reload-exclude='__pycache__' \
		--reload-exclude="$(BACKEND_SANDBOX_HOME)" \
		--reload-exclude="$(DEER_FLOW_HOME)"

gateway:
	PYTHONPATH=. PYTHONIOENCODING=utf-8 PYTHONUTF8=1 uv run python -m uvicorn app.gateway.app:app --host 0.0.0.0 --port 8001

# Default suite: quiet output. 11k+ tests make `-v` a measurable cost on its
# own; use `make test-verbose` when a per-test trace is actually wanted.
test:
	uv run python -m pytest -m "not live" tests/ -q

test-verbose:
	uv run python -m pytest -m "not live" tests/ -v

# Focused loop for the workflow/agent refactor.  This is the set that must stay
# green while changing runtime assembly; it is much cheaper than the full suite.
test-workflow:
	uv run python -m pytest $(wildcard tests/test_workflow_*.py) -q

# Optional parallel run.  pytest-xdist is installed locally with
# `uv pip install --python .venv pytest-xdist` because the workspace lock is
# currently blocked by the tenki-sandbox index gap.  `--dist loadfile` keeps a
# whole test file on one worker so module-level singletons still behave.
test-parallel:
	uv run python -m pytest -m "not live" tests/ -q -n auto --dist loadfile

test-live:
	DEER_FLOW_RUN_LIVE_TESTS=1 PYTHONPATH=. PYTHONIOENCODING=utf-8 PYTHONUTF8=1 uv run python -m pytest -m live tests/ -v -s

test-blocking-io:
	uv run python -m pytest tests/blocking_io -q --tb=short

lint:
	uv run ruff check .
	uv run ruff format --check .

format:
	uv run ruff check . --fix && uv run ruff format .

detect-blocking-io:
	@PYTHONPATH=. PYTHONIOENCODING=utf-8 PYTHONUTF8=1 uv run python ../scripts/detect_blocking_io_static.py --output ../.deer-flow/blocking-io-findings.json

# Generate a new alembic revision by autogenerating the diff against the live
# ORM models. Usage: make migrate-rev MSG="add foo column to runs"
# The Gateway runs `alembic upgrade head` automatically at startup via
# `bootstrap_schema`, so there is intentionally no `migrate` / `migrate-stamp`
# target -- the single execution path keeps ops mistakes off the table.
# The script builds a fresh temp SQLite at head, then diffs the live models
# against it, so a clean checkout does NOT need a pre-existing ./data/deerflow.db.
migrate-rev:
	@if [ -z "$(MSG)" ]; then echo 'usage: make migrate-rev MSG="describe the change"'; exit 1; fi
	PYTHONPATH=. PYTHONIOENCODING=utf-8 PYTHONUTF8=1 uv run python scripts/_autogen_revision.py "$(MSG)"


