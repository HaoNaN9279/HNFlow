"""Concrete application drivers (N4).

Slice 1 ships two drivers:

- :mod:`deerflow.apps.drivers.cli` — generic subprocess driver (real command
  execution on the host; the only driver exercised with a real process).
- :mod:`deerflow.apps.drivers.mock` — deterministic in-process driver for
  offline tests and demos (writes a marker artifact, never spawns anything).

Drivers are looked up by :func:`build_driver`.  Unknown driver names raise
:class:`deerflow.apps.driver.AppDriverError`; a *known* driver that cannot
operate a definition reports ``available() == False`` instead.
"""

from __future__ import annotations

from deerflow.apps.driver import AppDriver, AppDriverError

_DRIVER_FACTORIES: dict[str, str] = {
    "cli": "deerflow.apps.drivers.cli:CliAppDriver",
    "mock": "deerflow.apps.drivers.mock:MockAppDriver",
}


def build_driver(name: str) -> AppDriver:
    """Construct the driver registered under *name*.

    Raises:
        AppDriverError: when *name* is not a known driver.
    """
    path = _DRIVER_FACTORIES.get(name)
    if path is None:
        raise AppDriverError(f"unknown app driver {name!r} (known: {sorted(_DRIVER_FACTORIES)})")
    module_path, _, class_name = path.partition(":")
    import importlib

    module = importlib.import_module(module_path)
    driver_cls = getattr(module, class_name)
    return driver_cls()


__all__ = ["build_driver"]
