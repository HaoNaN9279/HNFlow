from __future__ import annotations

from datetime import UTC, datetime

import pytest

from deerflow.scheduler.payload import render_template, render_value

NOW = datetime(2026, 10, 14, 12, 0, 0, tzinfo=UTC)


def test_render_template_substitutes_payload_keys_into_prompt() -> None:
    rendered = render_template(
        {"prompt": "Re-import {{payload.path}} ({{payload.count}} files)"},
        {"path": "/data/a.fbx", "count": 3},
        now=NOW,
    )
    assert rendered == {"prompt": "Re-import /data/a.fbx (3 files)"}


def test_exact_placeholder_keeps_payload_type() -> None:
    rendered = render_template(
        {"count": "{{payload.count}}", "tags": "{{payload.tags}}", "meta": "{{payload.meta}}"},
        {"count": 3, "tags": ["a", "b"], "meta": {"k": "v"}},
        now=NOW,
    )
    assert rendered == {"count": 3, "tags": ["a", "b"], "meta": {"k": "v"}}


def test_nested_payload_path() -> None:
    assert render_template({"x": "{{ payload.event.status }}"}, {"event": {"status": "crashed"}}, now=NOW) == {"x": "crashed"}


def test_whole_payload_placeholder() -> None:
    rendered = render_template({"payload": "{{payload}}"}, {"a": 1}, now=NOW)
    assert rendered == {"payload": {"a": 1}}


def test_now_placeholder_is_iso_utc() -> None:
    assert render_template({"at": "{{now}}"}, {}, now=NOW) == {"at": "2026-10-14T12:00:00+00:00"}


def test_non_string_and_untemplated_values_pass_through() -> None:
    template = {"limit": 5, "flag": True, "none": None, "plain": "no placeholders", "nested": {"deep": "{{payload.v}}"}, "list": [1, "{{payload.v}}"]}
    rendered = render_template(template, {"v": "V"}, now=NOW)
    assert rendered == {"limit": 5, "flag": True, "none": None, "plain": "no placeholders", "nested": {"deep": "V"}, "list": [1, "V"]}


def test_missing_payload_key_raises() -> None:
    with pytest.raises(ValueError, match="payload has no key 'nope'"):
        render_template({"x": "{{payload.nope}}"}, {"path": "/a"}, now=NOW)


def test_empty_or_absent_template_renders_empty_mapping() -> None:
    assert render_template(None, {"a": 1}, now=NOW) == {}
    assert render_template({}, {"a": 1}, now=NOW) == {}


def test_render_value_handles_sequences_without_touching_bytes() -> None:
    assert render_value(b"bytes", {}, now=NOW) == b"bytes"
    assert render_value(("{{payload.a}}",), {"a": 1}, now=NOW) == [1]
