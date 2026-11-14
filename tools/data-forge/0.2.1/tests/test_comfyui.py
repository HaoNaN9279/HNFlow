"""Tests for the ComfyUI batch workflow tool."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from data_forge.tools.comfyui import (
    ComfyUIClient,
    _deep_merge,
    _load_workflow,
    run_batch,
    run_workflow,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def mock_requests():
    """Patch requests.post and requests.get with a controllable mock."""
    with patch("data_forge.tools.comfyui.requests") as mock_req:
        yield mock_req


@pytest.fixture
def client() -> ComfyUIClient:
    return ComfyUIClient("http://localhost:8188")


@pytest.fixture
def sample_workflow() -> dict:
    return {
        "3": {
            "class_type": "KSampler",
            "inputs": {"seed": 42, "steps": 20, "cfg": 7},
        },
        "9": {
            "class_type": "SaveImage",
            "inputs": {"filename_prefix": "Test"},
        },
    }


@pytest.fixture
def workflow_file(tmp_path: Path, sample_workflow: dict) -> Path:
    """Write a sample workflow JSON to a temp file."""
    path = tmp_path / "workflow_api.json"
    path.write_text(json.dumps(sample_workflow), encoding="utf-8")
    return path


# ---------------------------------------------------------------------------
# Deep merge tests
# ---------------------------------------------------------------------------


class TestDeepMerge:
    def test_merge_new_key(self) -> None:
        base = {"a": 1}
        result = _deep_merge(base, {"b": 2})
        assert result == {"a": 1, "b": 2}

    def test_merge_recursive(self) -> None:
        base = {"3": {"inputs": {"seed": 42, "steps": 20}}}
        overrides = {"3": {"inputs": {"seed": 99}}}
        result = _deep_merge(base, overrides)
        assert result["3"]["inputs"] == {"seed": 99, "steps": 20}

    def test_merge_does_not_mutate_original(self) -> None:
        base = {"x": [1, 2, 3]}
        result = _deep_merge(base, {"x": [4]})
        assert base["x"] == [1, 2, 3]
        assert result["x"] == [4]


# ---------------------------------------------------------------------------
# Workflow loading
# ---------------------------------------------------------------------------


class TestLoadWorkflow:
    def test_loads_valid_json(self, workflow_file: Path) -> None:
        wf = _load_workflow(workflow_file)
        assert "3" in wf

    def test_missing_file_raises(self, tmp_path: Path) -> None:
        with pytest.raises(FileNotFoundError):
            _load_workflow(tmp_path / "nope.json")


# ---------------------------------------------------------------------------
# Client tests (mocked HTTP)
# ---------------------------------------------------------------------------


class TestClientConnection:
    def test_default_url(self) -> None:
        c = ComfyUIClient()
        assert c.server_url == "http://127.0.0.1:8188"

    def test_custom_url_strips_trailing_slash(self) -> None:
        c = ComfyUIClient("http://example.com:9000/")
        assert c.server_url == "http://example.com:9000"

    def test_is_alive_true(self, mock_requests: MagicMock) -> None:
        mock_requests.get.return_value.status_code = 200
        c = ComfyUIClient()
        assert c.is_alive() is True

    def test_is_alive_false(self, mock_requests: MagicMock) -> None:
        mock_requests.get.side_effect = ConnectionError
        c = ComfyUIClient()
        assert c.is_alive() is False


class TestClientSubmit:
    def test_submit_returns_prompt_id(
        self, mock_requests: MagicMock, client: ComfyUIClient, sample_workflow: dict
    ) -> None:
        mock_requests.post.return_value.json.return_value = {
            "prompt_id": "abc-123",
            "number": 0,
        }
        mock_requests.post.return_value.raise_for_status = MagicMock()

        pid = client.submit(sample_workflow)
        assert pid == "abc-123"
        # Verify the payload is well-formed
        call_args = mock_requests.post.call_args
        payload = call_args.kwargs["json"]
        assert "prompt" in payload
        assert "client_id" in payload

    def test_submit_error_raises(
        self, mock_requests: MagicMock, client: ComfyUIClient, sample_workflow: dict
    ) -> None:
        mock_requests.post.return_value.raise_for_status.side_effect = (
            requests := __import__("requests")
        ).HTTPError("400")
        del requests

        with pytest.raises(__import__("requests").HTTPError):
            client.submit(sample_workflow)


class TestClientWait:
    def test_wait_completes_on_first_poll(
        self, mock_requests: MagicMock, client: ComfyUIClient
    ) -> None:
        mock_requests.get.return_value.json.return_value = {
            "test-id": {
                "status": {"status_str": "success", "completed": True},
                "outputs": {"9": {"images": []}},
            }
        }
        mock_requests.get.return_value.raise_for_status = MagicMock()

        entry = client.wait("test-id")
        assert entry["status"]["completed"] is True

    def test_wait_retries_until_complete(
        self, mock_requests: MagicMock, client: ComfyUIClient
    ) -> None:
        call_count = [0]

        def side_effect(*_a, **_kw):
            call_count[0] += 1
            resp = MagicMock()
            if call_count[0] < 3:
                resp.json.return_value = {}  # not ready yet
            else:
                resp.json.return_value = {
                    "test-id": {
                        "status": {"status_str": "success", "completed": True},
                        "outputs": {},
                    }
                }
            return resp

        mock_requests.get.side_effect = side_effect

        entry = client.wait("test-id", poll_interval=0.01)
        assert entry["status"]["completed"] is True
        assert call_count[0] >= 3

    def test_wait_error_raises_runtime_error(
        self, mock_requests: MagicMock, client: ComfyUIClient
    ) -> None:
        mock_requests.get.return_value.json.return_value = {
            "test-id": {
                "status": {
                    "status_str": "error",
                    "completed": False,
                    "messages": ["CUDA out of memory"],
                },
                "outputs": {},
            }
        }
        mock_requests.get.return_value.raise_for_status = MagicMock()

        with pytest.raises(RuntimeError, match="CUDA out of memory"):
            client.wait("test-id")


class TestClientOutputs:
    def test_download_outputs_saves_files(
        self,
        mock_requests: MagicMock,
        client: ComfyUIClient,
        tmp_path: Path,
    ) -> None:
        # Simulate history response with one image output
        mock_requests.get.return_value.json.return_value = {
            "pid": {
                "status": {"status_str": "success", "completed": True},
                "outputs": {
                    "9": {
                        "images": [
                            {
                                "filename": "result_00001_.png",
                                "subfolder": "",
                                "type": "output",
                                "format": "image/png",
                            }
                        ]
                    }
                },
            }
        }
        mock_requests.get.return_value.raise_for_status = MagicMock()
        mock_requests.get.return_value.content = b"fake-png-data"

        out_dir = tmp_path / "output"
        paths = client.download_outputs("pid", out_dir)

        assert len(paths) == 1
        assert paths[0].name == "result_00001_.png"
        assert paths[0].read_bytes() == b"fake-png-data"

    def test_download_skips_existing(
        self,
        mock_requests: MagicMock,
        client: ComfyUIClient,
        tmp_path: Path,
    ) -> None:
        mock_requests.get.return_value.json.return_value = {
            "pid": {
                "status": {"status_str": "success", "completed": True},
                "outputs": {
                    "9": {
                        "images": [
                            {
                                "filename": "result_00001_.png",
                                "subfolder": "",
                                "type": "output",
                            }
                        ]
                    }
                },
            }
        }
        mock_requests.get.return_value.raise_for_status = MagicMock()

        out_dir = tmp_path / "output"
        out_dir.mkdir()
        (out_dir / "result_00001_.png").write_text("preexisting")

        paths = client.download_outputs("pid", out_dir, overwrite=False)
        assert len(paths) == 0
        assert (out_dir / "result_00001_.png").read_text() == "preexisting"


class TestRun:
    def test_run_e2e(
        self,
        mock_requests: MagicMock,
        tmp_path: Path,
        sample_workflow: dict,
    ) -> None:
        # Mock submit
        post_resp = MagicMock()
        post_resp.json.return_value = {"prompt_id": "run-001"}
        # Mock history poll
        get_resp = MagicMock()
        get_resp.json.return_value = {
            "run-001": {
                "status": {"status_str": "success", "completed": True},
                "outputs": {
                    "9": {
                        "images": [
                            {
                                "filename": "img.png",
                                "subfolder": "",
                                "type": "output",
                            }
                        ]
                    }
                },
            }
        }
        get_resp.content = b"image-data"

        mock_requests.post.return_value = post_resp
        mock_requests.get.side_effect = [get_resp, get_resp, get_resp]

        client = ComfyUIClient()
        out_dir = tmp_path / "results"
        paths = client.run(sample_workflow, out_dir)

        assert len(paths) == 1
        assert (out_dir / "img.png").exists()


class TestQueueSize:
    def test_queue_size(self, mock_requests: MagicMock) -> None:
        mock_requests.get.return_value.json.return_value = {
            "exec_info": {"queue_remaining": 3}
        }
        c = ComfyUIClient()
        assert c.queue_size() == 3

    def test_queue_size_on_error(self, mock_requests: MagicMock) -> None:
        mock_requests.get.side_effect = ConnectionError
        c = ComfyUIClient()
        assert c.queue_size() == -1


class TestUploadImage:
    def test_upload_image(self, mock_requests: MagicMock, tmp_path: Path) -> None:
        img = tmp_path / "input.png"
        img.write_bytes(b"test-image")

        mock_requests.post.return_value.json.return_value = {
            "name": "input.png",
            "subfolder": "",
            "type": "input",
        }
        mock_requests.post.return_value.raise_for_status = MagicMock()

        client = ComfyUIClient()
        name = client.upload_image(img)
        assert name == "input.png"


# ---------------------------------------------------------------------------
# Standalone function tests
# ---------------------------------------------------------------------------


class TestRunWorkflow:
    def test_server_not_alive_raises(
        self, mock_requests: MagicMock, workflow_file: Path, tmp_path: Path
    ) -> None:
        mock_requests.get.side_effect = ConnectionError
        with pytest.raises(ConnectionError, match="not reachable"):
            run_workflow("http://localhost:8188", workflow_file, tmp_path / "out")

    def test_with_overrides(
        self, mock_requests: MagicMock, workflow_file: Path, tmp_path: Path
    ) -> None:
        # Mock is_alive check → OK
        get_alive = MagicMock()
        get_alive.status_code = 200
        # Mock submit
        post_resp = MagicMock()
        post_resp.json.return_value = {"prompt_id": "ov-001"}
        # Mock history + download
        get_resp = MagicMock()
        get_resp.json.return_value = {
            "ov-001": {
                "status": {"status_str": "success", "completed": True},
                "outputs": {},
            }
        }

        mock_requests.get.side_effect = [get_alive, get_resp, get_resp]
        mock_requests.post.return_value = post_resp

        overrides = {"3": {"inputs": {"seed": 123}}}
        results = run_workflow(
            "http://localhost:8188",
            workflow_file,
            tmp_path / "out",
            node_overrides=overrides,
        )
        assert results == []

    def test_missing_workflow_raises(self, tmp_path: Path) -> None:
        with pytest.raises(FileNotFoundError):
            run_workflow(
                "http://localhost:8188",
                tmp_path / "no_such_file.json",
                tmp_path / "out",
            )


class TestRunBatch:
    def test_batch_three_items(
        self, mock_requests: MagicMock, workflow_file: Path, tmp_path: Path
    ) -> None:
        # is_alive
        get_alive = MagicMock()
        get_alive.status_code = 200

        # submit
        post_resp = MagicMock()
        post_resp.json.return_value = {"prompt_id": "batch-001"}

        # history (empty outputs, completed)
        get_resp = MagicMock()
        get_resp.json.return_value = {
            "batch-001": {
                "status": {"status_str": "success", "completed": True},
                "outputs": {},
            }
        }

        mock_requests.get.side_effect = [
            get_alive,
            get_resp,
            get_resp,
            get_alive,
            get_resp,
            get_resp,
            get_alive,
            get_resp,
            get_resp,
        ]
        mock_requests.post.return_value = post_resp

        param_list = [
            {"3": {"inputs": {"seed": 1}}},
            {"3": {"inputs": {"seed": 2}}},
            {"3": {"inputs": {"seed": 3}}},
        ]

        results = run_batch(
            "http://localhost:8188",
            workflow_file,
            tmp_path / "batch_out",
            param_list,
        )

        assert len(results) == 3
        for i in range(3):
            assert (tmp_path / "batch_out" / f"batch_{i}").is_dir()
