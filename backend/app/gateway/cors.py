"""CORS origin configuration for the Gateway.

The unified nginx endpoint is same-origin by default. Split-origin or
port-forwarded browser clients opt in with ``GATEWAY_CORS_ORIGINS``
(comma-separated exact origins). The single source of truth lives here so
``CORSMiddleware`` and any origin check share the same normalization.
"""

import os
from urllib.parse import urlsplit

# Response headers a split-origin browser client must be able to read. Only the
# CORS-safelisted set is visible to JS by default, and the created run's id
# travels in `Content-Location` — the LangGraph SDK resolves run metadata from
# it, so withholding it leaves such a client unable to learn its own run id.
CORS_EXPOSED_HEADERS: tuple[str, ...] = ("Content-Location",)


def first_header_value(value: str | None) -> str | None:
    """Return the first value from a comma-separated proxy header."""
    if not value:
        return None
    first = value.split(",", 1)[0].strip()
    return first or None


def _host_with_optional_port(hostname: str, port: int | None, scheme: str) -> str:
    """Return normalized host[:port], omitting default ports."""
    host = hostname.lower()
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"

    if port is None or (scheme == "http" and port == 80) or (scheme == "https" and port == 443):
        return host
    return f"{host}:{port}"


def normalize_origin(origin: str) -> str | None:
    """Return a normalized scheme://host[:port] origin, or None for invalid input."""
    try:
        parsed = urlsplit(origin.strip())
        port = parsed.port
    except ValueError:
        return None

    scheme = parsed.scheme.lower()
    if scheme not in {"http", "https"} or not parsed.hostname:
        return None

    # Browser Origin is only scheme/host/port. Reject URL-shaped or credentialed values.
    if parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment:
        return None

    return f"{scheme}://{_host_with_optional_port(parsed.hostname, port, scheme)}"


def get_configured_cors_origins() -> set[str]:
    """Return normalized explicit browser origins from GATEWAY_CORS_ORIGINS."""
    origins: set[str] = set()
    for raw_origin in os.environ.get("GATEWAY_CORS_ORIGINS", "").split(","):
        origin = raw_origin.strip()
        if not origin or origin == "*":
            continue
        normalized = normalize_origin(origin)
        if normalized:
            origins.add(normalized)
    return origins
