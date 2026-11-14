"""Tests for the Ollama local model inference tool."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from data_forge.tools.ollama import (
    OllamaClient,
    batch_describe_images,
    batch_generate,
    describe_image,
    generate_text,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def mock_requests():
    """Patch requests module in ollama module."""
    with patch("data_forge.tools.ollama.requests") as mock_req:
        yield mock_req


@pytest.fixture
def client() -> OllamaClient:
    return OllamaClient(timeout=10)


# ---------------------------------------------------------------------------
# Client tests
# ---------------------------------------------------------------------------


class TestClientInit:
    def test_default_url(self) -> None:
        c = OllamaClient()
        assert c.base_url == "http://localhost:11434"

    def test_custom_url_strips_slash(self) -> None:
        c = OllamaClient("http://example.com:9999/")
        assert c.base_url == "http://example.com:9999"


class TestListModels:
    def test_list_models(self, mock_requests: MagicMock) -> None:
        mock_requests.get.return_value.json.return_value = {
            "models": [
                {"name": "llama3.2", "size": 2000000000},
                {"name": "gemma3:12b", "size": 8000000000},
            ]
        }
        mock_requests.get.return_value.raise_for_status = MagicMock()

        c = OllamaClient()
        models = c.list_models()
        assert len(models) == 2

    def test_list_model_names(self, mock_requests: MagicMock) -> None:
        mock_requests.get.return_value.json.return_value = {
            "models": [{"name": "llama3.2"}, {"name": "llava:13b"}]
        }
        mock_requests.get.return_value.raise_for_status = MagicMock()

        c = OllamaClient()
        names = c.list_model_names()
        assert names == ["llama3.2", "llava:13b"]

    def test_empty_model_list(self, mock_requests: MagicMock) -> None:
        mock_requests.get.return_value.json.return_value = {"models": []}
        mock_requests.get.return_value.raise_for_status = MagicMock()

        c = OllamaClient()
        assert c.list_models() == []


class TestPullModel:
    def test_pull_model(self, mock_requests: MagicMock) -> None:
        mock_requests.post.return_value.json.return_value = {"status": "success"}
        mock_requests.post.return_value.raise_for_status = MagicMock()

        c = OllamaClient()
        status = c.pull_model("llama3.2")
        assert status == "success"


class TestGenerate:
    def test_generate_basic(self, mock_requests: MagicMock) -> None:
        mock_requests.post.return_value.json.return_value = {
            "response": "The capital of France is Paris.",
            "done": True,
        }
        mock_requests.post.return_value.raise_for_status = MagicMock()

        c = OllamaClient()
        text = c.generate("What is the capital of France?", model="llama3.2")
        assert "Paris" in text

    def test_generate_with_system(self, mock_requests: MagicMock) -> None:
        mock_requests.post.return_value.json.return_value = {
            "response": "Bonjour!",
        }
        mock_requests.post.return_value.raise_for_status = MagicMock()

        c = OllamaClient()
        text = c.generate("Hello", model="llama3.2", system="Reply in French")
        assert "Bonjour" in text

    def test_generate_with_options(self, mock_requests: MagicMock) -> None:
        mock_requests.post.return_value.json.return_value = {"response": "ok"}
        mock_requests.post.return_value.raise_for_status = MagicMock()

        c = OllamaClient()
        c.generate(
            "test",
            model="llama3.2",
            temperature=0.3,
            top_p=0.5,
            max_tokens=100,
            repeat_penalty=1.1,
        )

        call_json = mock_requests.post.call_args.kwargs["json"]
        assert call_json["options"]["temperature"] == 0.3
        assert call_json["options"]["top_p"] == 0.5
        assert call_json["options"]["num_predict"] == 100
        assert call_json["options"]["repeat_penalty"] == 1.1

    def test_generate_stream_false(self, mock_requests: MagicMock) -> None:
        """Stream must always be False."""
        mock_requests.post.return_value.json.return_value = {"response": "ok"}
        mock_requests.post.return_value.raise_for_status = MagicMock()

        c = OllamaClient()
        c.generate("test", model="llama3.2")
        assert mock_requests.post.call_args.kwargs["json"]["stream"] is False


class TestChat:
    def test_chat(self, mock_requests: MagicMock) -> None:
        mock_requests.post.return_value.json.return_value = {
            "message": {"role": "assistant", "content": "I'm good, thanks!"}
        }
        mock_requests.post.return_value.raise_for_status = MagicMock()

        c = OllamaClient()
        resp = c.chat(
            [{"role": "user", "content": "How are you?"}],
            model="llama3.2",
        )
        assert "good" in resp.lower()


class TestDescribeImage:
    def test_describe_image(self, mock_requests: MagicMock, tmp_path: Path) -> None:
        mock_requests.post.return_value.json.return_value = {
            "response": "A cat on a couch."
        }
        mock_requests.post.return_value.raise_for_status = MagicMock()

        img = tmp_path / "cat.jpg"
        img.write_bytes(b"fake-image-data")

        c = OllamaClient()
        text = c.describe_image(img, model="llava")
        assert "cat" in text.lower()

        # Verify image was base64-encoded in request
        call_json = mock_requests.post.call_args.kwargs["json"]
        assert "images" in call_json
        assert len(call_json["images"]) == 1

    def test_describe_image_custom_prompt(
        self, mock_requests: MagicMock, tmp_path: Path
    ) -> None:
        mock_requests.post.return_value.json.return_value = {"response": "red"}
        mock_requests.post.return_value.raise_for_status = MagicMock()

        img = tmp_path / "test.png"
        img.write_bytes(b"data")

        c = OllamaClient()
        c.describe_image(img, "What color?", model="llava")
        call_json = mock_requests.post.call_args.kwargs["json"]
        assert call_json["prompt"] == "What color?"


# ---------------------------------------------------------------------------
# Convenience function tests
# ---------------------------------------------------------------------------


class TestGenerateText:
    def test_generate_text(self, mock_requests: MagicMock) -> None:
        mock_requests.post.return_value.json.return_value = {"response": "42"}
        mock_requests.post.return_value.raise_for_status = MagicMock()

        result = generate_text("Answer", model="llama3.2")
        assert result == "42"


class TestDescribeImageFn:
    def test_describe_image_fn(self, mock_requests: MagicMock, tmp_path: Path) -> None:
        mock_requests.post.return_value.json.return_value = {"response": "A dog"}
        mock_requests.post.return_value.raise_for_status = MagicMock()

        img = tmp_path / "dog.jpg"
        img.write_bytes(b"data")

        result = describe_image(img, model="llava")
        assert result == "A dog"


class TestBatchGenerate:
    def test_batch(self, mock_requests: MagicMock, tmp_path: Path) -> None:
        responses = iter(["Alpha", "Bravo", "Charlie"])

        def side_effect(*_a, **_kw):
            resp = MagicMock()
            resp.json.return_value = {"response": next(responses)}
            return resp

        mock_requests.post.side_effect = side_effect

        out_dir = tmp_path / "results"
        paths = batch_generate(
            ["prompt A", "prompt B", "prompt C"],
            out_dir,
            model="llama3.2",
        )

        assert len(paths) == 3
        assert (out_dir / "result_0.txt").read_text(encoding="utf-8") == "Alpha"
        assert (out_dir / "result_1.txt").read_text(encoding="utf-8") == "Bravo"
        assert (out_dir / "result_2.txt").read_text(encoding="utf-8") == "Charlie"

    def test_batch_error_continues(
        self, mock_requests: MagicMock, tmp_path: Path
    ) -> None:
        call_count = [0]

        def side_effect(*_a, **_kw):
            call_count[0] += 1
            if call_count[0] == 2:
                raise ConnectionError("fail")
            resp = MagicMock()
            resp.json.return_value = {"response": "ok"}
            return resp

        mock_requests.post.side_effect = side_effect

        out_dir = tmp_path / "results"
        paths = batch_generate(["a", "b", "c"], out_dir, model="llama3.2")
        assert len(paths) == 2  # middle one failed


class TestBatchDescribeImages:
    def test_batch_describe(self, mock_requests: MagicMock, tmp_path: Path) -> None:
        responses = iter(["A fish", "A bird"])

        def side_effect(*_a, **_kw):
            resp = MagicMock()
            resp.json.return_value = {"response": next(responses)}
            return resp

        mock_requests.post.side_effect = side_effect

        in_dir = tmp_path / "images"
        out_dir = tmp_path / "captions"
        in_dir.mkdir()
        (in_dir / "fish.jpg").write_bytes(b"img1")
        (in_dir / "bird.jpg").write_bytes(b"img2")

        paths = batch_describe_images(in_dir, out_dir, model="llava")
        assert len(paths) == 2
        # sorted: bird.jpg before fish.jpg
        assert (out_dir / "bird.txt").read_text(encoding="utf-8") == "A fish"
        assert (out_dir / "fish.txt").read_text(encoding="utf-8") == "A bird"

    def test_batch_describe_skips_existing(
        self, mock_requests: MagicMock, tmp_path: Path
    ) -> None:
        mock_requests.post.return_value.json.return_value = {"response": "new"}
        mock_requests.post.return_value.raise_for_status = MagicMock()

        in_dir = tmp_path / "images"
        out_dir = tmp_path / "captions"
        in_dir.mkdir()
        out_dir.mkdir()
        (in_dir / "img.jpg").write_bytes(b"data")
        (out_dir / "img.txt").write_text("preexisting", encoding="utf-8")

        paths = batch_describe_images(in_dir, out_dir, model="llava")
        assert len(paths) == 1
        assert (out_dir / "img.txt").read_text(encoding="utf-8") == "preexisting"

    def test_batch_skips_non_images(
        self, mock_requests: MagicMock, tmp_path: Path
    ) -> None:
        mock_requests.post.return_value.json.return_value = {"response": "ok"}
        mock_requests.post.return_value.raise_for_status = MagicMock()

        in_dir = tmp_path / "images"
        out_dir = tmp_path / "captions"
        in_dir.mkdir()
        (in_dir / "readme.txt").write_text("hello")
        (in_dir / "photo.jpg").write_bytes(b"img")

        paths = batch_describe_images(in_dir, out_dir, model="llava")
        assert len(paths) == 1
