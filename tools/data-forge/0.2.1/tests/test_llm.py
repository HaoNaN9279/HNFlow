"""Tests for the multi-provider LLM client tool."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from data_forge.tools.llm import (
    LLMClient,
    batch_chat,
    batch_describe_images,
    chat,
    describe_image,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_keyfile(path: Path, providers: dict) -> Path:
    path.write_text(json.dumps(providers), encoding="utf-8")
    return path


def _mock_chat_response(content: str) -> MagicMock:
    """Create a mock OpenAI chat completion response."""
    choice = MagicMock()
    choice.message.content = content
    resp = MagicMock()
    resp.choices = [choice]
    return resp


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def keyfile(tmp_path: Path) -> Path:
    return _make_keyfile(
        tmp_path / "keys.json",
        {
            "openai": {
                "api_key": "sk-test-openai",
                "base_url": "https://api.openai.com/v1",
            },
            "deepseek": {
                "api_key": "sk-test-ds",
                "base_url": "https://api.deepseek.com",
            },
        },
    )


@pytest.fixture
def minimal_keyfile(tmp_path: Path) -> Path:
    """Keyfile without explicit base_url — should default to OpenAI."""
    return _make_keyfile(
        tmp_path / "minimal.json",
        {"openai": {"api_key": "sk-test"}},
    )


# ---------------------------------------------------------------------------
# Keyfile loading
# ---------------------------------------------------------------------------


class TestKeyfileLoading:
    def test_loads_valid_keyfile(self, keyfile: Path) -> None:
        client = LLMClient(keyfile)
        assert client.list_providers() == ["openai", "deepseek"]

    def test_missing_file_raises(self, tmp_path: Path) -> None:
        with pytest.raises(FileNotFoundError):
            LLMClient(tmp_path / "nope.json")

    def test_missing_api_key_raises(self, tmp_path: Path) -> None:
        path = _make_keyfile(tmp_path / "bad.json", {"openai": {}})
        with pytest.raises(ValueError, match="api_key"):
            LLMClient(path)

    def test_not_a_dict_raises(self, tmp_path: Path) -> None:
        path = tmp_path / "bad.json"
        path.write_text("[1, 2, 3]")
        with pytest.raises(ValueError, match="JSON object"):
            LLMClient(path)

    def test_default_base_url(self, minimal_keyfile: Path) -> None:
        client = LLMClient(minimal_keyfile)
        assert client._providers["openai"]["base_url"] == "https://api.openai.com/v1"

    def test_nested_value_not_dict_raises(self, tmp_path: Path) -> None:
        path = _make_keyfile(tmp_path / "bad.json", {"openai": "not-a-dict"})
        with pytest.raises(ValueError, match="object"):
            LLMClient(path)


# ---------------------------------------------------------------------------
# Provider management
# ---------------------------------------------------------------------------


class TestProviders:
    def test_list_providers(self, keyfile: Path) -> None:
        client = LLMClient(keyfile)
        assert "openai" in client.list_providers()

    def test_unknown_provider_raises(self, keyfile: Path) -> None:
        client = LLMClient(keyfile)
        with pytest.raises(ValueError, match="Unknown provider"):
            client._get_client("nonexistent")


# ---------------------------------------------------------------------------
# Chat (mocked OpenAI)
# ---------------------------------------------------------------------------


class TestChat:
    def test_chat_text(self, keyfile: Path) -> None:
        with patch.object(LLMClient, "_get_client") as mock_get:
            mock_client = MagicMock()
            mock_client.chat.completions.create.return_value = _mock_chat_response(
                "Paris"
            )
            mock_get.return_value = mock_client

            client = LLMClient(keyfile)
            result = client.chat(
                "What is the capital of France?",
                provider="openai",
                model="gpt-4o",
            )
            assert result == "Paris"

    def test_chat_with_system(self, keyfile: Path) -> None:
        with patch.object(LLMClient, "_get_client") as mock_get:
            mock_client = MagicMock()
            mock_client.chat.completions.create.return_value = _mock_chat_response(
                "Bonjour"
            )
            mock_get.return_value = mock_client

            client = LLMClient(keyfile)
            result = client.chat(
                "Hello",
                provider="openai",
                model="gpt-4o",
                system="Reply in French",
            )
            assert result == "Bonjour"

    def test_chat_parameters_passed(self, keyfile: Path) -> None:
        with patch.object(LLMClient, "_get_client") as mock_get:
            mock_client = MagicMock()
            mock_client.chat.completions.create.return_value = _mock_chat_response("ok")
            mock_get.return_value = mock_client

            client = LLMClient(keyfile)
            client.chat(
                "test",
                provider="deepseek",
                model="deepseek-chat",
                temperature=0.3,
                max_tokens=256,
                top_p=0.5,
            )

            call_kwargs = mock_client.chat.completions.create.call_args.kwargs
            assert call_kwargs["model"] == "deepseek-chat"
            assert call_kwargs["temperature"] == 0.3
            assert call_kwargs["max_tokens"] == 256
            assert call_kwargs["top_p"] == 0.5

    def test_chat_empty_response(self, keyfile: Path) -> None:
        with patch.object(LLMClient, "_get_client") as mock_get:
            mock_client = MagicMock()
            choice = MagicMock()
            choice.message.content = None  # empty
            resp = MagicMock()
            resp.choices = [choice]
            mock_client.chat.completions.create.return_value = resp
            mock_get.return_value = mock_client

            client = LLMClient(keyfile)
            result = client.chat("test", provider="openai", model="gpt-4o")
            assert result == ""

    def test_client_cached(self, keyfile: Path) -> None:
        """Calling _get_client twice returns the same instance."""
        client = LLMClient(keyfile)
        c1 = client._get_client("openai")
        c2 = client._get_client("openai")
        assert c1 is c2


# ---------------------------------------------------------------------------
# Image description (mocked)
# ---------------------------------------------------------------------------


class TestDescribeImage:
    def test_describe_image(self, keyfile: Path, tmp_path: Path) -> None:
        img = tmp_path / "test.jpg"
        img.write_bytes(b"fake-jpeg")

        with patch.object(LLMClient, "_get_client") as mock_get:
            mock_client = MagicMock()
            mock_client.chat.completions.create.return_value = _mock_chat_response(
                "A cat on a sofa"
            )
            mock_get.return_value = mock_client

            client = LLMClient(keyfile)
            result = client.describe_image(img, model="gpt-4o", provider="openai")
            assert "cat" in result.lower()

            # Verify multimodal message format
            call_kwargs = mock_client.chat.completions.create.call_args.kwargs
            messages = call_kwargs["messages"]
            user_content = messages[-1]["content"]
            assert isinstance(user_content, list)
            assert user_content[0]["type"] == "text"
            assert user_content[1]["type"] == "image_url"

    def test_describe_image_custom_prompt(self, keyfile: Path, tmp_path: Path) -> None:
        img = tmp_path / "test.png"
        img.write_bytes(b"fake-png")

        with patch.object(LLMClient, "_get_client") as mock_get:
            mock_client = MagicMock()
            mock_client.chat.completions.create.return_value = _mock_chat_response(
                "blue"
            )
            mock_get.return_value = mock_client

            client = LLMClient(keyfile)
            result = client.describe_image(
                img,
                "What color is dominant?",
                provider="openai",
                model="gpt-4o",
            )
            assert result == "blue"


# ---------------------------------------------------------------------------
# Image encoding
# ---------------------------------------------------------------------------


class TestEncodeImage:
    def test_jpeg_encoding(self, keyfile: Path, tmp_path: Path) -> None:
        img = tmp_path / "photo.jpg"
        img.write_bytes(b"jpeg-data")

        client = LLMClient(keyfile)
        data_url = client._encode_image(img)
        assert data_url.startswith("data:image/jpeg;base64,")

    def test_png_encoding(self, keyfile: Path, tmp_path: Path) -> None:
        img = tmp_path / "icon.png"
        img.write_bytes(b"png-data")

        client = LLMClient(keyfile)
        data_url = client._encode_image(img)
        assert data_url.startswith("data:image/png;base64,")

    def test_unknown_extension_falls_back_to_jpeg(
        self, keyfile: Path, tmp_path: Path
    ) -> None:
        img = tmp_path / "unknown.xyz"
        img.write_bytes(b"data")

        client = LLMClient(keyfile)
        data_url = client._encode_image(img)
        assert data_url.startswith("data:image/jpeg;base64,")


# ---------------------------------------------------------------------------
# Convenience functions
# ---------------------------------------------------------------------------


class TestConvenienceFunctions:
    def test_chat_fn(self, keyfile: Path) -> None:
        with patch.object(LLMClient, "_get_client") as mock_get:
            mock_client = MagicMock()
            mock_client.chat.completions.create.return_value = _mock_chat_response(
                "Hello!"
            )
            mock_get.return_value = mock_client

            result = chat(
                "Hi",
                keyfile=keyfile,
                provider="openai",
                model="gpt-4o",
            )
            assert result == "Hello!"

    def test_describe_image_fn(self, keyfile: Path, tmp_path: Path) -> None:
        img = tmp_path / "img.jpg"
        img.write_bytes(b"data")

        with patch.object(LLMClient, "_get_client") as mock_get:
            mock_client = MagicMock()
            mock_client.chat.completions.create.return_value = _mock_chat_response(
                "A landscape"
            )
            mock_get.return_value = mock_client

            result = describe_image(
                img,
                keyfile=keyfile,
                provider="openai",
                model="gpt-4o",
            )
            assert result == "A landscape"


class TestBatchChat:
    def test_batch(self, keyfile: Path, tmp_path: Path) -> None:
        with patch.object(LLMClient, "_get_client") as mock_get:
            mock_client = MagicMock()
            responses = ["First", "Second", "Third"]

            def create_side_effect(**kwargs):
                nonlocal responses
                return _mock_chat_response(responses.pop(0))

            mock_client.chat.completions.create.side_effect = create_side_effect
            mock_get.return_value = mock_client

            out_dir = tmp_path / "results"
            paths = batch_chat(
                ["a", "b", "c"],
                out_dir,
                keyfile=keyfile,
                provider="openai",
                model="gpt-4o",
            )
            assert len(paths) == 3
            assert (out_dir / "result_0.txt").read_text() == "First"


class TestBatchDescribeImages:
    def test_batch(self, keyfile: Path, tmp_path: Path) -> None:
        in_dir = tmp_path / "images"
        out_dir = tmp_path / "captions"
        in_dir.mkdir()
        (in_dir / "a.jpg").write_bytes(b"img-a")
        (in_dir / "b.jpg").write_bytes(b"img-b")

        with patch.object(LLMClient, "_get_client") as mock_get:
            mock_client = MagicMock()
            responses = iter(["Caption A", "Caption B"])

            def create_side_effect(**kwargs):
                return _mock_chat_response(next(responses))

            mock_client.chat.completions.create.side_effect = create_side_effect
            mock_get.return_value = mock_client

            paths = batch_describe_images(
                in_dir,
                out_dir,
                keyfile=keyfile,
                provider="openai",
                model="gpt-4o",
            )
            assert len(paths) == 2
            assert (out_dir / "a.txt").read_text() == "Caption A"
            assert (out_dir / "b.txt").read_text() == "Caption B"

    def test_batch_skips_existing(self, keyfile: Path, tmp_path: Path) -> None:
        in_dir = tmp_path / "images"
        out_dir = tmp_path / "captions"
        in_dir.mkdir()
        out_dir.mkdir()
        (in_dir / "img.jpg").write_bytes(b"data")
        (out_dir / "img.txt").write_text("existing", encoding="utf-8")

        # Should not call the API
        with patch.object(LLMClient, "_get_client") as mock_get:
            mock_get.return_value = MagicMock()

            paths = batch_describe_images(
                in_dir,
                out_dir,
                keyfile=keyfile,
                provider="openai",
                model="gpt-4o",
            )
            assert len(paths) == 1
            assert (out_dir / "img.txt").read_text() == "existing"
