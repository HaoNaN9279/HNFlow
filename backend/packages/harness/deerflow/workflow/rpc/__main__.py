"""``python -m deerflow.workflow.rpc`` — the headless engine on stdio."""

from __future__ import annotations

import asyncio

from deerflow.workflow.rpc.server import serve


def main() -> int:
    """Run the RPC loop until EOF or ``engine/shutdown``."""
    return asyncio.run(serve())


if __name__ == "__main__":
    raise SystemExit(main())
