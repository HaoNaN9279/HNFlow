"""``python -m deerflow.workflow`` entry point — delegates to the cycle checker."""

from __future__ import annotations

from deerflow.workflow.check_cycles import main

if __name__ == "__main__":
    raise SystemExit(main())
