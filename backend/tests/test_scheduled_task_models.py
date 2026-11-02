import pytest
from pydantic import ValidationError

from deerflow.config.app_config import AppConfig
from deerflow.config.scheduler_config import SchedulerConfig
from deerflow.persistence.models import ScheduledTaskRow, ScheduledTaskRunRow


def test_app_config_exposes_scheduler_section():
    config = AppConfig.model_validate(
        {
            "models": [],
            "sandbox": {"use": "local"},
        }
    )
    assert config.scheduler.enabled is False
    assert config.scheduler.poll_interval_seconds == 5
    assert config.scheduler.lease_seconds == 120


def test_scheduler_config_retry_backoff_defaults():
    """N7 retry knobs default to a 60s base capped at 1h."""
    scheduler = SchedulerConfig()
    assert scheduler.retry_backoff_seconds == 60
    assert scheduler.max_retry_backoff_seconds == 3600


def test_scheduler_config_rejects_cap_below_base():
    with pytest.raises(ValidationError, match="max_retry_backoff_seconds"):
        SchedulerConfig(retry_backoff_seconds=120, max_retry_backoff_seconds=60)


def test_scheduler_config_rejects_non_positive_backoff():
    with pytest.raises(ValidationError):
        SchedulerConfig(retry_backoff_seconds=0)


def test_scheduled_task_models_registered():
    assert ScheduledTaskRow.__tablename__ == "scheduled_tasks"
    assert ScheduledTaskRunRow.__tablename__ == "scheduled_task_runs"


def test_scheduled_task_row_has_trigger_and_retry_columns():
    columns = ScheduledTaskRow.__table__.columns
    assert {"target_kind", "target_definition_id", "payload_template", "max_attempts", "attempt"} <= set(columns.keys())
    assert columns["target_kind"].server_default is not None
    assert columns["max_attempts"].server_default is not None
    run_columns = ScheduledTaskRunRow.__table__.columns
    assert {"dedupe_key", "attempt"} <= set(run_columns.keys())
    assert "uq_scheduled_task_run_dedupe" in {index.name for index in ScheduledTaskRunRow.__table__.indexes}
