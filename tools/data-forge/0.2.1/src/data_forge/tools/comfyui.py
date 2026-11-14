"""ComfyUI batch workflow execution tool.

Connects to a locally-deployed ComfyUI server, submits workflow JSON files,
tracks execution, and downloads generated outputs.

Requires:
    - ``requests`` (included in core dependencies)
    - A running ComfyUI instance at a reachable URL
"""

from __future__ import annotations

import copy
import json
import time
import uuid
from pathlib import Path
from typing import Any

import requests


class ComfyUIClient:
    """Client for a ComfyUI server's REST API.

    Args:
        server_url: Base URL of the ComfyUI server.
            Defaults to ``"http://127.0.0.1:8188"``.
        timeout: HTTP request timeout in seconds.

    Example:
        >>> client = ComfyUIClient()
        >>> client.is_alive()
        True
        >>> workflow = json.loads(Path("workflow_api.json").read_text())
        >>> prompt_id = client.submit(workflow)
        >>> history = client.wait(prompt_id)
        >>> paths = client.download_outputs(prompt_id, Path("output/"))
    """

    def __init__(
        self,
        server_url: str = "http://127.0.0.1:8188",
        timeout: float = 30.0,
        *,
        proxies: dict[str, str] | None = None,
    ) -> None:
        self.server_url: str = server_url.rstrip("/")
        self.timeout: float = timeout
        self.proxies: dict[str, str] | None = proxies
        # Client ID for associating WebSocket events (even though we poll)
        self._client_id: str = str(uuid.uuid4())
        self._request_kwargs: dict[str, Any] = {
            "timeout": self.timeout,
        }
        if self.proxies is not None:
            self._request_kwargs["proxies"] = self.proxies

    # ------------------------------------------------------------------
    # Connection helpers
    # ------------------------------------------------------------------

    def _url(self, path: str) -> str:
        """Build a full API URL from a relative path."""
        return f"{self.server_url}/api{path}"

    def is_alive(self) -> bool:
        """Check whether the ComfyUI server is reachable."""
        try:
            resp = requests.get(
                f"{self.server_url}/system_stats",
                **self._request_kwargs,
            )
            return resp.status_code == 200
        except Exception:
            return False

    # ------------------------------------------------------------------
    # Image upload
    # ------------------------------------------------------------------

    def upload_image(
        self,
        image_path: str | Path,
        *,
        subfolder: str = "",
        overwrite: bool = True,
    ) -> str:
        """Upload an image file to the ComfyUI input directory.

        Args:
            image_path: Path to the image to upload.
            subfolder: Optional subfolder name on the server.
            overwrite: Replace existing file with the same name.

        Returns:
            The filename as registered on the server (for use in
            ``LoadImage`` nodes).
        """
        src = Path(image_path)
        with open(src, "rb") as fh:
            resp = requests.post(
                self._url("/upload/image"),
                files={"image": (src.name, fh)},
                data={
                    "type": "input",
                    "subfolder": subfolder,
                    "overwrite": str(overwrite).lower(),
                },
                **self._request_kwargs,
            )
        resp.raise_for_status()
        return resp.json()["name"]

    # ------------------------------------------------------------------
    # Workflow submission
    # ------------------------------------------------------------------

    def submit(self, workflow: dict[str, Any]) -> str:
        """Submit a workflow for execution.

        Args:
            workflow: Workflow dict in ComfyUI API format (node IDs as
                string keys, each containing ``class_type`` and ``inputs``).

        Returns:
            The ``prompt_id`` UUID that identifies this execution.

        Raises:
            requests.HTTPError: If the workflow validation fails (400).
        """
        payload = {
            "prompt": workflow,
            "client_id": self._client_id,
        }
        resp = requests.post(
            self._url("/prompt"),
            json=payload,
            **self._request_kwargs,
        )
        resp.raise_for_status()
        return resp.json()["prompt_id"]

    # ------------------------------------------------------------------
    # Progress tracking (polling)
    # ------------------------------------------------------------------

    def wait(
        self,
        prompt_id: str,
        *,
        poll_interval: float = 1.0,
        progress_callback: Any = None,
    ) -> dict[str, Any]:
        """Block until the submitted workflow finishes execution.

        Args:
            prompt_id: The UUID returned by :meth:`submit`.
            poll_interval: Seconds between each status poll.
            progress_callback: Optional callable receiving ``(node_id,
                value, max_value)`` on each progress tick (only meaningful
                for long-running nodes like KSampler).

        Returns:
            The history entry for *prompt_id* (a dict with ``outputs``,
            ``prompt``, and ``status`` keys).

        Raises:
            RuntimeError: If the executor reports an error.
            TimeoutError: If execution takes longer than 1 hour (3600
                seconds of wall-clock time).
        """
        elapsed = 0.0
        max_wait = 3600.0  # 1-hour safety net

        while elapsed < max_wait:
            resp = requests.get(
                self._url(f"/history/{prompt_id}"),
                **self._request_kwargs,
            )
            resp.raise_for_status()
            data = resp.json()

            if data and prompt_id in data:
                entry = data[prompt_id]
                status = entry.get("status", {})

                if status.get("status_str") == "error":
                    messages = status.get("messages", [])
                    detail = messages[-1] if messages else "unknown error"
                    raise RuntimeError(f"Workflow failed: {detail}")

                if status.get("completed"):
                    return entry

            time.sleep(poll_interval)
            elapsed += poll_interval

        raise TimeoutError(f"Workflow {prompt_id} did not complete within {max_wait}s")

    # ------------------------------------------------------------------
    # Retrieve outputs
    # ------------------------------------------------------------------

    def get_output_info(self, prompt_id: str) -> list[dict[str, str]]:
        """List output images produced by a completed workflow.

        Returns a list of dicts with keys ``filename``, ``subfolder``,
        ``type``, and ``format``.
        """
        history = self.wait(prompt_id)
        images: list[dict[str, str]] = []
        for _node_id, output in history.get("outputs", {}).items():
            for img_info in output.get("images", []):
                images.append(
                    {
                        "filename": img_info["filename"],
                        "subfolder": img_info.get("subfolder", ""),
                        "type": img_info.get("type", "output"),
                        "format": img_info.get("format", "image/png"),
                    }
                )
        return images

    def download_outputs(
        self,
        prompt_id: str,
        output_dir: str | Path,
        *,
        overwrite: bool = True,
    ) -> list[Path]:
        """Download all output images of a completed workflow.

        Args:
            prompt_id: UUID returned by :meth:`submit`.
            output_dir: Directory to save downloaded files.
            overwrite: Replace existing files with the same name.

        Returns:
            List of :class:`~pathlib.Path` for each downloaded file.
        """
        out = Path(output_dir)
        out.mkdir(parents=True, exist_ok=True)

        images = self.get_output_info(prompt_id)
        saved: list[Path] = []

        for img in images:
            dst = out / img["filename"]
            if dst.exists() and not overwrite:
                continue

            resp = requests.get(
                self._url("/view"),
                params={
                    "filename": img["filename"],
                    "type": img["type"],
                    "subfolder": img["subfolder"],
                },
                **self._request_kwargs,
            )
            resp.raise_for_status()
            dst.write_bytes(resp.content)
            saved.append(dst)

        return saved

    # ------------------------------------------------------------------
    # Convenience: run workflow end-to-end
    # ------------------------------------------------------------------

    def run(
        self,
        workflow: dict[str, Any],
        output_dir: str | Path,
    ) -> list[Path]:
        """Submit, wait, and download — all in one call.

        Args:
            workflow: Workflow dict in ComfyUI API format.
            output_dir: Where to save output files.

        Returns:
            Paths to downloaded output files.
        """
        prompt_id = self.submit(workflow)
        return self.download_outputs(prompt_id, output_dir)

    # ------------------------------------------------------------------
    # Utility: queue status
    # ------------------------------------------------------------------

    def queue_size(self) -> int:
        """Return the number of pending items in the execution queue."""
        try:
            resp = requests.get(
                self._url("/prompt"),
                **self._request_kwargs,
            )
            data = resp.json()
            return data.get("exec_info", {}).get("queue_remaining", 0)
        except Exception:
            return -1


# ======================================================================
# Standalone convenience functions
# ======================================================================


def _load_workflow(path: str | Path) -> dict[str, Any]:
    """Load a ComfyUI API-format workflow JSON file."""
    src = Path(path)
    if not src.is_file():
        raise FileNotFoundError(f"Workflow file not found: {src}")
    return json.loads(src.read_text(encoding="utf-8"))


def _deep_merge(base: dict[str, Any], overrides: dict[str, Any]) -> dict[str, Any]:
    """Merge *overrides* into *base* recursively (in-place on a copy)."""
    result = copy.deepcopy(base)
    for key, value in overrides.items():
        if key in result and isinstance(result[key], dict) and isinstance(value, dict):
            result[key] = _deep_merge(result[key], value)
        else:
            result[key] = value
    return result


def run_workflow(
    server_url: str,
    workflow_path: str | Path,
    output_dir: str | Path,
    *,
    node_overrides: dict[str, Any] | None = None,
    timeout: float = 30.0,
) -> list[Path]:
    """Execute a single ComfyUI workflow and download the outputs.

    Args:
        server_url: ComfyUI server base URL (e.g. ``"http://127.0.0.1:8188"``).
        workflow_path: Path to a ComfyUI API-format workflow JSON file.
        output_dir: Directory for downloaded output images.
        node_overrides: Optional dict of node-level overrides to apply
            to the workflow before submission.  Keys are node IDs (as
            strings), values are partial ``{class_type, inputs}`` dicts
            that get merged in.
        timeout: HTTP request timeout in seconds.

    Returns:
        Paths to all downloaded output files.

    Raises:
        ConnectionError: If the ComfyUI server is not reachable.
    """
    workflow = _load_workflow(workflow_path)
    if node_overrides:
        workflow = _deep_merge(workflow, node_overrides)

    client = ComfyUIClient(server_url, timeout=timeout)
    if not client.is_alive():
        raise ConnectionError(f"ComfyUI server not reachable at {server_url}")

    return client.run(workflow, output_dir)


def run_batch(
    server_url: str,
    workflow_path: str | Path,
    output_dir: str | Path,
    param_list: list[dict[str, Any]],
    *,
    timeout: float = 30.0,
) -> list[list[Path]]:
    """Execute a workflow multiple times with different parameter sets.

    Each item in *param_list* is a node-override dict (same format as
    ``node_overrides`` in :func:`run_workflow`).  For each set of
    overrides, a sub-directory named ``batch_N`` is created inside
    *output_dir* where ``N`` is the 0-based index.

    Args:
        server_url: ComfyUI server base URL.
        workflow_path: Path to workflow JSON file.
        output_dir: Root directory for batch outputs.
        param_list: List of node-override dicts, one per batch item.
        timeout: HTTP request timeout in seconds.

    Returns:
        Nested list — ``results[i]`` is the list of :class:`~pathlib.Path`
        outputs for the i-th batch item.
    """
    base_workflow = _load_workflow(workflow_path)

    client = ComfyUIClient(server_url, timeout=timeout)
    if not client.is_alive():
        raise ConnectionError(f"ComfyUI server not reachable at {server_url}")

    all_results: list[list[Path]] = []

    for idx, overrides in enumerate(param_list):
        workflow = _deep_merge(base_workflow, overrides)
        batch_dir = Path(output_dir) / f"batch_{idx}"
        paths = client.run(workflow, batch_dir)
        all_results.append(paths)

    return all_results
