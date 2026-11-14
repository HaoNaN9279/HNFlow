"""Frontmatter parser tests."""

from __future__ import annotations

from hnflow_stack.frontmatter import parse_frontmatter


def test_parses_scalars_lists_and_body() -> None:
    parsed = parse_frontmatter(
        "---\n"
        "name: sample\n"
        "allowed-tools: [read, write]\n"
        "metadata:\n"
        "  owner: test\n"
        "---\n"
        "\n"
        "# Body\n"
    )
    assert parsed.data["name"] == "sample"
    assert parsed.data["allowed-tools"] == ["read", "write"]
    assert "metadata" in parsed.data
    assert parsed.body == "# Body"


def test_parses_block_scalars() -> None:
    folded = parse_frontmatter("---\ndescription: >\n  one\n  two\n---\nbody")
    literal = parse_frontmatter("---\ndescription: |\n  one\n  two\n---\nbody")
    assert folded.data["description"] == "one two"
    assert literal.data["description"] == "one\ntwo"


def test_missing_frontmatter_returns_body() -> None:
    parsed = parse_frontmatter("# Body\n")
    assert parsed.data == {}
    assert parsed.body == "# Body"
