"""Scene-change detection: shot boundaries for aligning marks.

Writes ``scenes.json`` — a chronological list of timestamps where the picture
cuts to a new shot (the first entry is always ``0.0``). The agent uses these to
keep each captured frame inside a single, complete shot instead of landing on a
transition.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

from video_transcribe.ffmpeg import scene_change_times
from video_transcribe.paths import Job

DEFAULT_THRESHOLD = 0.3


@dataclass
class SceneList:
    """Detected scene boundaries, persisted to ``scenes.json``."""

    threshold: float
    scenes: list[float] = field(default_factory=list)

    def to_dict(self) -> dict:
        """Return a JSON-serialisable mapping."""
        return {"threshold": self.threshold, "scenes": self.scenes}

    def save(self, path: Path) -> None:
        """Write the scene list as JSON to *path*."""
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(self.to_dict(), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    @classmethod
    def load(cls, path: Path) -> "SceneList":
        """Load a scene list from *path*."""
        data = json.loads(path.read_text(encoding="utf-8"))
        return cls(
            threshold=float(data.get("threshold", DEFAULT_THRESHOLD)),
            scenes=[float(value) for value in data.get("scenes", [])],
        )


def detect(job: Job, *, threshold: float = DEFAULT_THRESHOLD) -> SceneList:
    """Detect shot boundaries in *job*'s video and write ``scenes.json``.

    Args:
        job: The job to analyse.
        threshold: Scene score (0–1) above which a frame starts a new shot.

    Returns:
        The resulting :class:`SceneList`.

    Raises:
        SceneDetectionError: If ffmpeg fails.
    """
    times = scene_change_times(job.video_path, threshold=threshold)
    result = SceneList(threshold=threshold, scenes=times)
    result.save(job.scenes_path)
    return result
