"""Minimal custom tool package.

Tool packages are trusted local code: they are imported into the Gateway
process when a capability group or workflow resolves them.
"""

from langchain_core.tools import tool


@tool
def echo(text: str) -> str:
    """Return *text* unchanged. Useful as a package-layout template."""
    return text


def build_tool():
    return echo
