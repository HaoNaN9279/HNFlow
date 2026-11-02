"""Read-only feature-flag endpoint for the frontend bootstrap.

Reports which optional, config-gated features are exposed over HTTP so the
frontend can gate UI and avoid firing requests that the backend would reject
with 403. Reads through ``get_config`` so edits to ``config.yaml`` take effect
on the next request without a restart (config hot-reload boundary).
"""

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from app.gateway.browser_capability import browser_capability
from app.gateway.deps import get_config
from deerflow.config.app_config import AppConfig

router = APIRouter(prefix="/api", tags=["features"])


class AgentsApiFeature(BaseModel):
    """Availability of the custom-agent management API."""

    enabled: bool = Field(..., description="Whether the agents_api routes are exposed over HTTP")


class BrowserControlFeature(BaseModel):
    """Availability of live agentic browser control."""

    enabled: bool = Field(..., description="Whether the live browser routes and UI are available")


class AppsFeature(BaseModel):
    """Availability of the local professional-software access layer (N4)."""

    enabled: bool = Field(..., description="Whether the local-application registry and app:* nodes are available")


class EnvironmentFeature(BaseModel):
    """Availability of the environment report (N11)."""

    enabled: bool = Field(..., description="Whether environment probing and GET /api/environment report anything")


class FeaturesResponse(BaseModel):
    """Frontend-facing feature availability flags."""

    agents_api: AgentsApiFeature
    browser_control: BrowserControlFeature
    apps: AppsFeature
    environment: EnvironmentFeature


@router.get(
    "/features",
    response_model=FeaturesResponse,
    summary="List Feature Flags",
    description="Report which optional config-gated features are enabled, so the frontend can gate UI before issuing requests.",
)
async def list_features(config: AppConfig = Depends(get_config)) -> FeaturesResponse:
    """Return availability of optional, config-gated frontend features."""
    browser = browser_capability(config)
    return FeaturesResponse(
        agents_api=AgentsApiFeature(enabled=config.agents_api.enabled),
        browser_control=BrowserControlFeature(enabled=browser.available),
        apps=AppsFeature(enabled=config.apps.enabled),
        environment=EnvironmentFeature(enabled=_environment_enabled(config)),
    )


def _environment_enabled(config: AppConfig) -> bool:
    """Read ``apps.environment.enabled`` defensively — this is a read-only probe.

    A feature-availability read must not 500 because a config object is missing a
    section; the default (probing on) matches both ``EnvironmentConfig`` and every
    deployment where the section simply is not written out.
    """
    environment = getattr(getattr(config, "apps", None), "environment", None)
    return bool(getattr(environment, "enabled", True))
