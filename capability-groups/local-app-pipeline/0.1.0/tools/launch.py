"""Deterministic local-app launch helper used by capability-group tests."""

from __future__ import annotations


def launch(app: str, script: str) -> dict[str, str]:
    return {"app": app, "script": script, "status": "started"}
