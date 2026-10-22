"""The launcher must warm a workspace route that still exists."""

from __future__ import annotations

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SERVE_SH = REPO_ROOT / "scripts" / "serve.sh"


def test_readiness_probes_use_workflows_workspace_route() -> None:
    text = SERVE_SH.read_text(encoding="utf-8")

    assert "http://127.0.0.1:3000/workspace/workflows" in text
    assert "http://127.0.0.1:2026/workspace/workflows" in text
    assert "/workspace/chats" not in text
