#!/usr/bin/env python3
"""Wait for an HTTP endpoint to answer successfully.

A listening TCP port is not readiness: Next.js opens port 3000 before the first
route has compiled, and nginx then holds the browser request until its upstream
timeout.  Startup must wait for the actual page.

Usage:
    python scripts/wait-for-http.py <url> [timeout_seconds] [service_name]
"""

from __future__ import annotations

import sys
import time
import urllib.error
import urllib.request


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("Usage: wait-for-http.py <url> [timeout] [service]", file=sys.stderr)
        return 2
    url = argv[1]
    timeout = int(argv[2]) if len(argv) > 2 else 180
    service = argv[3] if len(argv) > 3 else "Service"

    # Never route a loopback readiness probe through the operator's HTTP proxy.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    deadline = time.monotonic() + timeout
    while True:
        try:
            request = urllib.request.Request(url, headers={"Cache-Control": "no-cache", "User-Agent": "hnflow-readiness"})
            with opener.open(request, timeout=5) as response:
                body = response.read(8192)
                content_type = response.headers.get("Content-Type", "")
                # A 200 error shell is not a usable page.  The workflow chat
                # route must render an HTML document before we call it ready.
                if response.status < 500 and "text/html" in content_type.lower() and (b"<html" in body.lower() or b"<!doctype html" in body.lower()):
                    print(f"  {service} is ready at {url}")
                    return 0
        except (urllib.error.URLError, TimeoutError, OSError):
            pass

        if time.monotonic() >= deadline:
            print(f"  {service} did not become ready at {url} within {timeout}s", file=sys.stderr)
            return 1
        print(f"  Waiting for {service} at {url}...", flush=True)
        time.sleep(1)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
