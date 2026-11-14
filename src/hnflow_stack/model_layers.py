"""Platform-wide model-layer catalog.

A model layer is a named route profile. Capability groups reference a layer by
id only; the concrete provider/model/reasoningEffort binding is machine-local
and belongs to an agent adapter. Keeping the catalog here makes the layer list
identical for every adapter instead of letting each plugin invent its own.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ModelLayer:
    """One platform model layer."""

    id: str
    label: str
    description: str
    kind: str
    rank: int

    def to_dict(self) -> dict[str, object]:
        return {
            "id": self.id,
            "label": self.label,
            "description": self.description,
            "kind": self.kind,
            "rank": self.rank,
        }


#: Default common layer catalog. Order is the display order.
MODEL_LAYERS: tuple[ModelLayer, ...] = (
    ModelLayer(
        id="fast",
        label="快速",
        description="检索、摘要、文档查找、简单编辑与格式转换；低延迟优先。",
        kind="speed",
        rank=1,
    ),
    ModelLayer(
        id="standard",
        label="标准",
        description="日常开发、命令执行、脚手架与普通问答；通用默认层。",
        kind="balanced",
        rank=2,
    ),
    ModelLayer(
        id="strong",
        label="深度",
        description="架构设计、规划、复杂调试、代码审查与疑难根因；深度推理优先。",
        kind="reasoning",
        rank=3,
    ),
    ModelLayer(
        id="vision",
        label="多模态",
        description="图像、截图、PDF 页面等视觉输入理解。",
        kind="multimodal",
        rank=4,
    ),
)

#: Layer used when a session has no explicit default.
DEFAULT_MODEL_LAYER = "standard"

#: Valid ids referenced by capability groups.
MODEL_LAYER_IDS: frozenset[str] = frozenset(layer.id for layer in MODEL_LAYERS)


def model_layer_catalog() -> list[dict[str, object]]:
    """Return a fresh serializable copy of the platform catalog."""
    return [layer.to_dict() for layer in MODEL_LAYERS]


def model_layer(id: str) -> ModelLayer | None:
    """Return one layer by id, or ``None`` when unknown."""
    for layer in MODEL_LAYERS:
        if layer.id == id:
            return layer
    return None


def is_model_layer(value: str) -> bool:
    """Whether *value* is a platform layer id."""
    return value in MODEL_LAYER_IDS
