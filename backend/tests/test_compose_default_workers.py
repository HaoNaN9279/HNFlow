"""Regression test for the Docker Compose Gateway worker count.

The Gateway holds run state (RunManager and the in-process memory stream bridge)
in process, so the single-user deployment runs exactly one Uvicorn worker.
Running more than one worker without a shared cross-worker stream bridge breaks
run cancellation, SSE reconnects, and request de-duplication (nginx has no
sticky sessions, so requests scatter across workers that each keep their own run
state). This test pins the single-worker deployment so it cannot silently
regress.
"""

from __future__ import annotations

from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
COMPOSE_PATH = REPO_ROOT / "docker" / "docker-compose.yaml"


def _compose() -> dict:
    return yaml.safe_load(COMPOSE_PATH.read_text(encoding="utf-8"))


def _gateway_command() -> str:
    """Return the gateway service command as a single string."""
    command = _compose()["services"]["gateway"]["command"]
    if isinstance(command, list):
        command = " ".join(str(part) for part in command)
    return command


def test_gateway_runs_a_single_worker():
    """The compose gateway must run exactly one worker (no override knob)."""
    command = _gateway_command()
    assert "--workers 1" in command, f"gateway must run one worker; got: {command}"
    assert "GATEWAY_WORKERS" not in command, f"single-user deployment must not expose a worker-count override; got: {command}"


def test_compose_has_no_redis_service():
    """The single-user deployment uses the in-process memory stream bridge."""
    services = _compose()["services"]
    assert "redis" not in services, f"redis service must be removed; got services: {sorted(services)}"
