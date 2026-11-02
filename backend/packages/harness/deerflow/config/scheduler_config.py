from pydantic import BaseModel, Field, model_validator


class SchedulerConfig(BaseModel):
    enabled: bool = Field(default=False)
    poll_interval_seconds: int = Field(default=5, ge=1, le=300)
    lease_seconds: int = Field(default=120, ge=5, le=3600)
    max_concurrent_runs: int = Field(default=3, ge=1, le=32)
    min_once_delay_seconds: int = Field(default=60, ge=1, le=86400)
    # Retry backoff for a failed task that still has attempts left (N7):
    # delay = min(retry_backoff_seconds * 2**attempt, max_retry_backoff_seconds).
    retry_backoff_seconds: int = Field(default=60, ge=1, le=86400)
    max_retry_backoff_seconds: int = Field(default=3600, ge=1, le=86400)

    @model_validator(mode="after")
    def _check_backoff_bounds(self) -> "SchedulerConfig":
        if self.max_retry_backoff_seconds < self.retry_backoff_seconds:
            raise ValueError("max_retry_backoff_seconds must be >= retry_backoff_seconds")
        return self
