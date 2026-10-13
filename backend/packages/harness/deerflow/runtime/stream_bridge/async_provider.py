"""Async stream bridge factory.

Provides an **async context manager** aligned with
:func:`deerflow.runtime.checkpointer.async_provider.make_checkpointer`.

The single-user build always yields the in-process
:class:`~deerflow.runtime.stream_bridge.memory.MemoryStreamBridge`; agent workers
and SSE endpoints share one Gateway process, so no cross-process transport is
involved.

Usage (e.g. FastAPI lifespan)::

    from deerflow.runtime.stream_bridge import make_stream_bridge

    async with make_stream_bridge() as bridge:
        app.state.stream_bridge = bridge
"""

from __future__ import annotations

import contextlib
import logging
from collections.abc import AsyncIterator

from deerflow.config.app_config import AppConfig
from deerflow.config.stream_bridge_config import get_stream_bridge_config

from .base import StreamBridge

logger = logging.getLogger(__name__)


def _resolve_queue_maxsize(app_config: AppConfig | None) -> int:
    if app_config is not None:
        config = app_config.stream_bridge
    else:
        config = get_stream_bridge_config()
    return config.queue_maxsize if config is not None else 256


@contextlib.asynccontextmanager
async def make_stream_bridge(app_config: AppConfig | None = None) -> AsyncIterator[StreamBridge]:
    """Async context manager that yields the in-process memory :class:`StreamBridge`."""
    from deerflow.runtime.stream_bridge.memory import MemoryStreamBridge

    maxsize = _resolve_queue_maxsize(app_config)
    bridge = MemoryStreamBridge(queue_maxsize=maxsize)
    logger.info("Stream bridge initialised: memory (queue_maxsize=%d)", maxsize)
    try:
        yield bridge
    finally:
        await bridge.close()
