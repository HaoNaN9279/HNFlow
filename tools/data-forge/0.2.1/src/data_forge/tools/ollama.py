"""Ollama local model inference tool.

Connects to a local Ollama server, sends text or image prompts to
user-specified models, and collects generated responses.
"""

from __future__ import annotations

import base64
from pathlib import Path
from typing import Any

import requests


class OllamaClient:
    """Client for the Ollama REST API.

    Args:
        base_url: Ollama server URL. Defaults to ``"http://localhost:11434"``.
        timeout: Request timeout in seconds (generation may be slow).

    Example:
        >>> client = OllamaClient()
        >>> client.list_models()
        ['llama3.2', 'gemma3:12b']
        >>> client.generate("What is 2+2?", model="llama3.2")
        '2+2 equals 4.'
    """

    def __init__(
        self,
        base_url: str = "http://localhost:11434",
        timeout: float = 300.0,
    ) -> None:
        self.base_url: str = base_url.rstrip("/")
        self.timeout: float = timeout

    # ------------------------------------------------------------------
    # Core API
    # ------------------------------------------------------------------

    def _post(self, path: str, json_data: dict[str, Any]) -> dict[str, Any]:
        """Send a POST request to the Ollama API."""
        resp = requests.post(
            f"{self.base_url}{path}",
            json=json_data,
            timeout=self.timeout,
        )
        resp.raise_for_status()
        return resp.json()

    def _get(self, path: str) -> dict[str, Any]:
        """Send a GET request to the Ollama API."""
        resp = requests.get(
            f"{self.base_url}{path}",
            timeout=self.timeout,
        )
        resp.raise_for_status()
        return resp.json()

    # ------------------------------------------------------------------
    # Model management
    # ------------------------------------------------------------------

    def list_models(self) -> list[dict[str, Any]]:
        """Return installed model metadata.

        Each dict contains ``name``, ``modified_at``, ``size``,
        ``digest``, and ``details``.
        """
        data = self._get("/api/tags")
        return data.get("models", [])

    def list_model_names(self) -> list[str]:
        """Return installed model names only."""
        return [m["name"] for m in self.list_models()]

    def pull_model(self, name: str, *, stream: bool = False) -> str:
        """Download a model from the Ollama registry.

        Returns a status message.
        """
        data = self._post("/api/pull", {"name": name, "stream": stream})
        return data.get("status", "unknown")

    # ------------------------------------------------------------------
    # Text generation
    # ------------------------------------------------------------------

    def generate(
        self,
        prompt: str,
        *,
        model: str,
        system: str | None = None,
        temperature: float = 0.7,
        top_p: float = 0.9,
        top_k: int = 40,
        max_tokens: int | None = None,
        **extra: Any,
    ) -> str:
        """Generate a text completion from a single prompt.

        Args:
            prompt: The input prompt.
            model: Ollama model name (e.g. ``"llama3.2"``).
            system: Optional system prompt.
            temperature: Sampling temperature (0-2).
            top_p: Nucleus sampling probability.
            top_k: Top-k sampling.
            max_tokens: Maximum tokens to generate.
            **extra: Additional parameters passed directly to the API
                (e.g. ``repeat_penalty``, ``stop`` sequences).

        Returns:
            The generated text.
        """
        payload: dict[str, Any] = {
            "model": model,
            "prompt": prompt,
            "stream": False,
            "options": {
                "temperature": temperature,
                "top_p": top_p,
                "top_k": top_k,
            },
        }
        if system is not None:
            payload["system"] = system
        if max_tokens is not None:
            payload["options"]["num_predict"] = max_tokens
        payload["options"].update(extra)

        data = self._post("/api/generate", payload)
        return data.get("response", "")

    def chat(
        self,
        messages: list[dict[str, str]],
        *,
        model: str,
        temperature: float = 0.7,
        **extra: Any,
    ) -> str:
        """Generate a chat completion from a conversation history.

        Args:
            messages: List of ``{"role": "...", "content": "..."}`` dicts.
            model: Model name.
            temperature: Sampling temperature.
            **extra: Additional API parameters.

        Returns:
            The assistant's response text.
        """
        payload: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "stream": False,
            "options": {"temperature": temperature},
        }
        payload["options"].update(extra)

        data = self._post("/api/chat", payload)
        return data.get("message", {}).get("content", "")

    # ------------------------------------------------------------------
    # Image understanding (vision models)
    # ------------------------------------------------------------------

    @staticmethod
    def _encode_image(image_path: str | Path) -> str:
        """Base64-encode an image for Ollama vision API."""
        src = Path(image_path)
        data = src.read_bytes()
        return base64.b64encode(data).decode("utf-8")

    def describe_image(
        self,
        image_path: str | Path,
        prompt: str = "Describe this image in detail.",
        *,
        model: str,
        system: str | None = None,
        temperature: float = 0.7,
        **extra: Any,
    ) -> str:
        """Ask a vision model to describe an image.

        Args:
            image_path: Path to the image file.
            prompt: Question or instruction about the image.
            model: A vision-capable model (e.g. ``"llava"``,
                ``"bakllava"``, ``"minicpm-v"``).
            system: Optional system prompt.
            temperature: Sampling temperature.
            **extra: Additional API parameters.

        Returns:
            The model's description.
        """
        img_b64 = self._encode_image(image_path)
        payload: dict[str, Any] = {
            "model": model,
            "prompt": prompt,
            "images": [img_b64],
            "stream": False,
            "options": {"temperature": temperature},
        }
        if system is not None:
            payload["system"] = system
        payload["options"].update(extra)

        data = self._post("/api/generate", payload)
        return data.get("response", "")


# ======================================================================
# Convenience functions
# ======================================================================


def generate_text(
    prompt: str,
    *,
    model: str,
    base_url: str = "http://localhost:11434",
    system: str | None = None,
    temperature: float = 0.7,
    timeout: float = 300.0,
    **extra: Any,
) -> str:
    """Generate text from a single prompt via local Ollama.

    Args:
        prompt: The input prompt.
        model: Ollama model name.
        base_url: Ollama server URL.
        system: Optional system prompt.
        temperature: Sampling temperature.
        timeout: HTTP request timeout.
        **extra: Extra parameters passed to the API.

    Returns:
        Generated text string.

    Example:
        >>> generate_text("Explain gravity", model="llama3.2")
        'Gravity is a fundamental force...'
    """
    client = OllamaClient(base_url, timeout=timeout)
    return client.generate(
        prompt, model=model, system=system, temperature=temperature, **extra
    )


def describe_image(
    image_path: str | Path,
    prompt: str = "Describe this image in detail.",
    *,
    model: str,
    base_url: str = "http://localhost:11434",
    timeout: float = 300.0,
    **extra: Any,
) -> str:
    """Ask a vision model to describe an image via local Ollama.

    Args:
        image_path: Path to the image.
        prompt: Question about the image.
        model: Vision-capable model name.
        base_url: Ollama server URL.
        timeout: HTTP request timeout.
        **extra: Extra parameters.

    Returns:
        Model's description.

    Example:
        >>> describe_image("photo.jpg", model="llava")
        'The image shows a cat sitting on a windowsill...'
    """
    client = OllamaClient(base_url, timeout=timeout)
    return client.describe_image(image_path, prompt=prompt, model=model, **extra)


def batch_generate(
    prompts: list[str],
    output_dir: str | Path,
    *,
    model: str,
    base_url: str = "http://localhost:11434",
    system: str | None = None,
    temperature: float = 0.7,
    timeout: float = 300.0,
    **extra: Any,
) -> list[Path]:
    """Generate responses for multiple prompts, saving each to a file.

    Each prompt is processed sequentially.  Results are written to
    ``output_dir/result_N.txt`` where *N* is the 0-based index.

    Args:
        prompts: List of prompt strings.
        output_dir: Directory for output text files.
        model: Ollama model name.
        base_url: Ollama server URL.
        system: Optional system prompt.
        temperature: Sampling temperature.
        timeout: HTTP request timeout.
        **extra: Extra API parameters.

    Returns:
        List of :class:`~pathlib.Path` for each output file.

    Raises:
        ConnectionError: If Ollama is not reachable.
    """
    client = OllamaClient(base_url, timeout=timeout)
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)
    saved: list[Path] = []

    for i, prompt in enumerate(prompts):
        dst = out / f"result_{i}.txt"
        try:
            text = client.generate(
                prompt,
                model=model,
                system=system,
                temperature=temperature,
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
    model: str,
    prompt: str = "Describe this image in detail.",
    base_url: str = "http://localhost:11434",
    timeout: float = 300.0,
    **extra: Any,
) -> list[Path]:
    """Describe all images in a directory using a vision model.

    Each image produces a ``<image_stem>.txt`` file in *output_dir*.

    Args:
        input_dir: Directory containing images.
        output_dir: Directory for output text files.
        model: Vision-capable model name.
        prompt: Instruction/question for each image.
        base_url: Ollama server URL.
        timeout: HTTP request timeout.
        **extra: Extra API parameters.

    Returns:
        Paths to generated text files.
    """
    client = OllamaClient(base_url, timeout=timeout)
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
                model=model,
                **extra,
            )
            dst.write_text(text, encoding="utf-8")
            saved.append(dst)
        except Exception:
            continue

    return saved
