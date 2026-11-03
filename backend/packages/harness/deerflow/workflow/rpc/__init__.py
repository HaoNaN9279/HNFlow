"""Headless JSON-RPC surface for the workflow engine.

The DSH plugin drives workflow runs through this package instead of the HTTP
gateway: line-delimited JSON-RPC 2.0 over stdio, no FastAPI, no database.  See
``docs/dsh-plugin-plan.md`` §3.3 for the process model and §8 for the run model.

Entry point::

    python -m deerflow.workflow.rpc
"""

from __future__ import annotations

from deerflow.workflow.rpc.protocol import PROTOCOL_VERSION, EngineError, InvalidParams, RpcError
from deerflow.workflow.rpc.runner import RunHost
from deerflow.workflow.rpc.server import ENGINE_NAME, ENGINE_VERSION, RpcServer, serve

__all__ = [
    "ENGINE_NAME",
    "ENGINE_VERSION",
    "PROTOCOL_VERSION",
    "EngineError",
    "InvalidParams",
    "RpcError",
    "RpcServer",
    "RunHost",
    "serve",
]
