"""Application registry view (N4).

A thin, read-only view over :class:`deerflow.config.apps_config.AppsConfig`
that resolves application names to their :class:`AppDefinition` and builds the
matching driver.  It holds no runtime state — live instances/sessions belong
to :mod:`deerflow.apps.session` — so it can be rebuilt cheaply after a config
reload (though the ``apps`` section is restart-required, see the plan).
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field

from deerflow.apps.driver import AppDriver, AppDriverError
from deerflow.apps.drivers import build_driver
from deerflow.apps.presence import HUMAN_CONFLICT_FAIL
from deerflow.config.apps_config import AppDefinition, AppsConfig, get_apps_config


@dataclass(frozen=True)
class AppRegistry:
    """Immutable view over the configured applications."""

    enabled: bool = False
    definitions: Mapping[str, AppDefinition] = field(default_factory=dict)
    #: N10b (§17): what to do when a person is using an application the engine
    #: wants (``fail`` / ``wait`` / ``preempt``).  Carried here because the
    #: session manager — the single choke point — enforces it and is built from
    #: this view rather than from the whole config.
    on_human_conflict: str = HUMAN_CONFLICT_FAIL
    #: N10b: how long a ``wait`` human-conflict admission queues before failing
    #: (mirrors ``apps.acquire_timeout_seconds``, the N8 budget).
    acquire_timeout_seconds: float = 60.0

    @classmethod
    def from_config(cls, config: AppsConfig) -> AppRegistry:
        return cls(
            enabled=config.enabled,
            definitions=dict(config.definitions),
            on_human_conflict=config.on_human_conflict,
            acquire_timeout_seconds=config.acquire_timeout_seconds,
        )

    def get(self, name: str) -> AppDefinition | None:
        return self.definitions.get(name)

    def names(self) -> list[str]:
        return sorted(self.definitions)

    def entries(self) -> list[tuple[str, AppDefinition]]:
        return [(name, self.definitions[name]) for name in self.names()]

    def build_driver(self, name: str) -> AppDriver:
        """Build the driver declared by the definition *name*.

        Raises:
            AppDriverError: when the app is unknown or its driver is unknown.
        """
        definition = self.get(name)
        if definition is None:
            raise AppDriverError(f"unknown application {name!r}")
        return build_driver(definition.driver)

    def describe(self) -> list[dict[str, object]]:
        """Serialize the registry for the ``GET /api/apps`` surface.

        Each entry reports whether its driver can operate the definition and
        what the definition declares it occupies (N8); driver construction
        failures are reported as ``available: false`` rather than raised
        (fail-open read).
        """
        out: list[dict[str, object]] = []
        for name, definition in self.entries():
            available = False
            error: str | None = None
            try:
                available = bool(self.build_driver(name).available(definition))
            except Exception as exc:  # noqa: BLE001 - fail-open per entry
                error = str(exc)
            out.append(
                {
                    "name": name,
                    "driver": definition.driver,
                    "description": definition.description,
                    "available": available,
                    "error": error,
                    "resources": definition.resources.numeric(),
                    "license": definition.resources.license,
                }
            )
        return out


def get_app_registry() -> AppRegistry:
    """Build an :class:`AppRegistry` from the current ``apps`` config singleton."""
    return AppRegistry.from_config(get_apps_config())


__all__ = ["AppRegistry", "get_app_registry"]
