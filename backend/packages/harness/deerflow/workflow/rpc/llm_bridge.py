"""A chat model that answers through the harness instead of a provider.

Stage 2 of the model bridge: instead of duplicating provider credentials in
HNFlow config, an AI node can name a model entry whose ``use`` is
:class:`BridgeChatModel`. The class forwards the assembled messages to the
plugin over the same stdio channel that carries the run protocol, and the plugin
runs them on the harness's own LLM service.

Only the shapes the workflow AI executor needs are implemented: a system/user
conversation and a plain text answer. Tool calling, streaming callbacks, and
provider-specific thinking controls stay with the harness adapter.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from typing import Any

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from pydantic import ConfigDict, Field

logger = logging.getLogger(__name__)

#: Async callable installed by the server: ``payload -> {"text": str, "usage": dict}``.
Transport = Callable[[dict[str, Any]], Awaitable[dict[str, Any]]]

_transport: Transport | None = None


def set_transport(transport: Transport | None) -> None:
    """Install (or clear) the channel to the harness client."""
    global _transport
    _transport = transport


def get_transport() -> Transport | None:
    """The currently installed channel, if any."""
    return _transport


def _role_of(message: BaseMessage) -> str:
    """Map a LangChain message onto a chat role."""
    kind = getattr(message, "type", "")
    if kind == "system":
        return "system"
    if kind == "ai":
        return "assistant"
    return "user"


def _text_of(message: BaseMessage) -> str:
    """Flatten a LangChain message's content into plain text."""
    content = message.content
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict) and isinstance(block.get("text"), str):
                parts.append(block["text"])
        return "".join(parts)
    return str(content)


def to_wire(messages: list[BaseMessage]) -> list[dict[str, str]]:
    """Convert messages to the plugin's request shape."""
    return [{"role": _role_of(message), "text": _text_of(message)} for message in messages]


class BridgeChatModel(BaseChatModel):
    """A chat model whose completions run in the harness process."""

    model_config = ConfigDict(extra="allow", populate_by_name=True, protected_namespaces=())

    provider_name: str = Field(default="", alias="provider")
    model_name: str = Field(default="", alias="model")
    timeout: float | None = Field(default=None)

    @property
    def _llm_type(self) -> str:
        """LangChain identifier for this model."""
        return "hnflow-bridge"

    @property
    def _identifying_params(self) -> dict[str, Any]:
        """Parameters that identify this model instance."""
        return {"provider": self.provider_name, "model": self.model_name}

    def bind_tools(self, tools: Any, **kwargs: Any) -> BridgeChatModel:
        """Accept a tool binding without acting on it.

        The workflow AI executor builds a LangChain agent, which always binds its
        tool list to the model. The bridge answers text only, so the binding is a
        no-op: tools stay unavailable to the node but the call does not fail.
        """
        return self

    def _payload(self, messages: list[BaseMessage]) -> dict[str, Any]:
        """Build the plugin request."""
        return {
            "provider": self.provider_name,
            "model": self.model_name,
            "messages": to_wire(messages),
            **({"timeoutMs": int(self.timeout * 1000)} if self.timeout else {}),
        }

    async def _agenerate(self, messages: list[BaseMessage], stop: list[str] | None = None, run_manager: Any = None, **kwargs: Any) -> ChatResult:
        """Ask the harness for one completion."""
        transport = get_transport()
        if transport is None:
            raise RuntimeError("no harness LLM transport is installed; the bridge model requires a live plugin connection")
        reply = await transport(self._payload(messages))
        text = reply.get("text") if isinstance(reply, dict) else None
        if not isinstance(text, str):
            raise RuntimeError("the harness LLM bridge returned no text")
        usage = reply.get("usage") if isinstance(reply.get("usage"), dict) else {}
        message = AIMessage(content=text, usage_metadata=usage or None)
        return ChatResult(generations=[ChatGeneration(message=message)])

    def _generate(self, messages: list[BaseMessage], stop: list[str] | None = None, run_manager: Any = None, **kwargs: Any) -> ChatResult:
        """Synchronous entry point; the engine always has a running loop."""
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return asyncio.run(self._agenerate(messages, stop, run_manager, **kwargs))
        raise RuntimeError("BridgeChatModel must be called with the async API while an event loop is running")


__all__ = ["BridgeChatModel", "get_transport", "set_transport", "to_wire"]
