"""Configuration for the stream bridge.

The single-user build ships only the in-process memory bridge: agent workers and
SSE endpoints run in the same Gateway process, so no cross-process transport is
needed. Only the retained-buffer size is configurable.
"""

from pydantic import BaseModel, Field


class StreamBridgeConfig(BaseModel):
    """Configuration for the stream bridge that connects agent workers to SSE endpoints."""

    queue_maxsize: int = Field(
        default=256,
        description="Maximum number of events retained per run in the in-process memory bridge.",
    )


# Global configuration instance — None means no stream bridge is configured
# (falls back to memory with defaults).
_stream_bridge_config: StreamBridgeConfig | None = None


def get_stream_bridge_config() -> StreamBridgeConfig | None:
    """Get the current stream bridge configuration, or None if not configured."""
    return _stream_bridge_config


def set_stream_bridge_config(config: StreamBridgeConfig | None) -> None:
    """Set the stream bridge configuration."""
    global _stream_bridge_config
    _stream_bridge_config = config


def load_stream_bridge_config_from_dict(config_dict: dict | None) -> None:
    """Load stream bridge configuration from a dictionary."""
    global _stream_bridge_config
    if config_dict is None:
        _stream_bridge_config = None
        return
    _stream_bridge_config = StreamBridgeConfig(**config_dict)
