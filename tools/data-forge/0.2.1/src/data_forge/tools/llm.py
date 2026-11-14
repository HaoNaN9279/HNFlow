"""Multi-provider LLM client tool.

Reads API keys from a JSON keyfile, sends text and image prompts to
cloud LLM providers, and returns generated responses.

Supported providers: any OpenAI-compatible API (OpenAI, DeepSeek, Groq,
Together, vLLM, Ollama, etc.).

Requires:
    - ``openai`` SDK (included in core dependencies)
    - A JSON keyfile with provider credentials

Keyfile format::

    {
      "openai": {
        "api_key": "sk-...",
        "base_url": "https://api.openai.com/v1"
      },
      "deepseek": {
        "api_key": "sk-...",
        "base_url": "https://api.deepseek.com"
      }
    }
"""

from __future__ import annotations

import base64
import json
from pathlib import Path
from typing import Any

from openai import OpenAI


class LLMClient:
    """Unified client for multiple LLM providers via OpenAI-compatible APIs.

    Args:
        keyfile: Path to a JSON file mapping provider names to
            ``{api_key, base_url}`` dicts.

    Example:
        >>> client = LLMClient("api_keys.json")
        >>> client.list_providers()
        ['openai', 'deepseek']
        >>> client.chat("What is Python?", provider="openai", model="gpt-4o")
        'Python is a high-level programming language...'
    """

    def __init__(self, keyfile: str | Path) -> None:
        self._providers: dict[str, dict[str, str]] = self._load_keyfile(keyfile)
        self._clients: dict[str, OpenAI] = {}

    # ------------------------------------------------------------------
    # Keyfile management
    # ------------------------------------------------------------------

    @staticmethod
    def _load_keyfile(path: str | Path) -> dict[str, dict[str, str]]:
        """Load and validate the keyfile."""
        src = Path(path)
        if not src.is_file():
            raise FileNotFoundError(f"Keyfile not found: {src}")

        data = json.loads(src.read_text(encoding="utf-8"))

        if not isinstance(data, dict):
            raise ValueError("Keyfile must be a JSON object")

        validated: dict[str, dict[str, str]] = {}
        for name, cfg in data.items():
            if not isinstance(cfg, dict):
                raise ValueError(f"Provider '{name}' must be an object with 'api_key'")
            if "api_key" not in cfg:
                raise ValueError(
                    f"Provider '{name}' is missing required field 'api_key'"
                )
            validated[name] = {
                "api_key": cfg["api_key"],
                "base_url": cfg.get("base_url", "https://api.openai.com/v1"),
            }
        return validated

    # ------------------------------------------------------------------
    # Provider management
    # ------------------------------------------------------------------

    def list_providers(self) -> list[str]:
        """Return available provider names from the keyfile."""
        return list(self._providers.keys())

    def _get_client(self, provider: str) -> OpenAI:
        """Get or create an OpenAI client for *provider*."""
        if provider not in self._providers:
            raise ValueError(
                f"Unknown provider '{provider}'. Available: {self.list_providers()}"
            )
        if provider not in self._clients:
            cfg = self._providers[provider]
            self._clients[provider] = OpenAI(
                api_key=cfg["api_key"],
                base_url=cfg["base_url"],
            )
        return self._clients[provider]

    # ------------------------------------------------------------------
    # Text chat
    # ------------------------------------------------------------------

    def chat(
        self,
        prompt: str,
        *,
        provider: str,
        model: str,
        system: str | None = None,
        temperature: float = 0.7,
        max_tokens: int | None = None,
        **extra: Any,
    ) -> str:
        """Send a text prompt and return the model's response.

        Args:
            prompt: User message text.
            provider: Provider name (must exist in keyfile).
            model: Model name (e.g. ``"gpt-4o"``, ``"deepseek-chat"``).
            system: Optional system message.
            temperature: Sampling temperature (0-2).
            max_tokens: Maximum tokens to generate.
            **extra: Additional parameters passed to the API
                (e.g. ``top_p``, ``frequency_penalty``).

        Returns:
            The assistant's text response.
        """
        messages: list[dict[str, Any]] = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})

        client = self._get_client(provider)
        params: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "temperature": temperature,
        }
        if max_tokens is not None:
            params["max_tokens"] = max_tokens
        params.update(extra)

        resp = client.chat.completions.create(**params)
        return resp.choices[0].message.content or ""

    # ------------------------------------------------------------------
    # Multimodal (image + text)
    # ------------------------------------------------------------------

    @staticmethod
    def _encode_image(image_path: str | Path) -> str:
        """Base64-encode an image as a data URL."""
        src = Path(image_path)
        ext = src.suffix.lower().lstrip(".")
        mime_map = {
            "jpg": "jpeg",
            "jpeg": "jpeg",
            "png": "png",
            "gif": "gif",
            "webp": "webp",
            "bmp": "bmp",
        }
        mime = mime_map.get(ext, "jpeg")
        data = base64.b64encode(src.read_bytes()).decode("utf-8")
        return f"data:image/{mime};base64,{data}"

    def describe_image(
        self,
        image_path: str | Path,
        prompt: str = "Describe this image in detail.",
        *,
        provider: str,
        model: str,
        system: str | None = None,
        temperature: float = 0.7,
        max_tokens: int | None = None,
        **extra: Any,
    ) -> str:
        """Ask a vision-capable model to describe an image.

        Args:
            image_path: Path to the image file.
            prompt: Question or instruction about the image.
            provider: Provider name.
            model: Vision-capable model name (e.g. ``"gpt-4o"``).
            system: Optional system message.
            temperature: Sampling temperature.
            max_tokens: Maximum tokens.
            **extra: Extra API parameters.

        Returns:
            The model's description text.
        """
        data_url = self._encode_image(image_path)

        content: list[dict[str, Any]] = [
            {"type": "text", "text": prompt},
            {"type": "image_url", "image_url": {"url": data_url}},
        ]

        messages: list[dict[str, Any]] = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": content})

        client = self._get_client(provider)
        params: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "temperature": temperature,
        }
        if max_tokens is not None:
            params["max_tokens"] = max_tokens
        params.update(extra)

        resp = client.chat.completions.create(**params)
        return resp.choices[0].message.content or ""


# ======================================================================
# Convenience functions
# ======================================================================


def chat(
    prompt: str,
    *,
    keyfile: str | Path,
    provider: str,
    model: str,
    system: str | None = None,
    temperature: float = 0.7,
    max_tokens: int | None = None,
    **extra: Any,
) -> str:
    """One-shot text generation.

    Example:
        >>> chat("Hello", keyfile="keys.json", provider="openai", model="gpt-4o")
        'Hello! How can I help you?'
    """
    client = LLMClient(keyfile)
    return client.chat(
        prompt,
        provider=provider,
        model=model,
        system=system,
        temperature=temperature,
        max_tokens=max_tokens,
        **extra,
    )


def describe_image(
    image_path: str | Path,
    prompt: str = "Describe this image in detail.",
    *,
    keyfile: str | Path,
    provider: str,
    model: str,
    system: str | None = None,
    temperature: float = 0.7,
    max_tokens: int | None = None,
    **extra: Any,
) -> str:
    """One-shot image description.

    Example:
        >>> describe_image("photo.jpg", keyfile="keys.json", provider="openai", model="gpt-4o")
        'This image shows a sunset over the ocean...'
    """
    client = LLMClient(keyfile)
    return client.describe_image(
        image_path,
        prompt=prompt,
        provider=provider,
        model=model,
        system=system,
        temperature=temperature,
        max_tokens=max_tokens,
        **extra,
    )


def batch_chat(
    prompts: list[str],
    output_dir: str | Path,
    *,
    keyfile: str | Path,
    provider: str,
    model: str,
    system: str | None = None,
    temperature: float = 0.7,
    max_tokens: int | None = None,
    **extra: Any,
) -> list[Path]:
    """Batch text generation, saving each response to a file.

    Results are written to ``output_dir/result_N.txt``.

    Returns:
        Paths to generated output files.
    """
    client = LLMClient(keyfile)
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)
    saved: list[Path] = []

    for i, prompt in enumerate(prompts):
        dst = out / f"result_{i}.txt"
        try:
            text = client.chat(
                prompt,
                provider=provider,
                model=model,
                system=system,
                temperature=temperature,
                max_tokens=max_tokens,
                **extra,
            )
            dst.write_text(text, encoding="utf-8")
            saved.append(dst)
        except Exception:
            continue

    return saved


def batch_describe_images(
    input_dir: str | Path,
    output_dir: str | Path,
    *,
    keyfile: str | Path,
    provider: str,
    model: str,
    prompt: str = "Describe this image in detail.",
    system: str | None = None,
    temperature: float = 0.7,
    max_tokens: int | None = None,
    **extra: Any,
) -> list[Path]:
    """Describe all images in a directory, saving each to ``<stem>.txt``.

    Returns:
        Paths to generated text files.
    """
    client = LLMClient(keyfile)
    in_dir = Path(input_dir)
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)

    _supported = frozenset(
        {
            ".avif",
            ".bmp",
            ".gif",
            ".ico",
            ".jfif",
            ".jpeg",
            ".jpg",
            ".pjp",
            ".pjpeg",
            ".png",
            ".tif",
            ".tiff",
            ".webp",
        }
    )

    images = sorted(
        f for f in in_dir.iterdir() if f.is_file() and f.suffix.lower() in _supported
    )
    saved: list[Path] = []

    for img_path in images:
        dst = out / f"{img_path.stem}.txt"
        if dst.exists():
            saved.append(dst)
            continue
        try:
            text = client.describe_image(
                img_path,
                prompt=prompt,
                provider=provider,
                model=model,
                system=system,
                temperature=temperature,
                max_tokens=max_tokens,
                **extra,
            )
            dst.write_text(text, encoding="utf-8")
            saved.append(dst)
        except Exception:
            continue

    return saved
