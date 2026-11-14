"""``python -m hnflow_forge`` entry point."""

from __future__ import annotations

import sys

from hnflow_forge.cli import main

if __name__ == "__main__":
    sys.exit(main())
