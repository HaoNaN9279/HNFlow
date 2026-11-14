"""Offline static checks for HNFlow flow definitions (``schemaVersion: 2``).

Mirrors ``dsh-hnflow`` 0.6.0 ``lib/flow/validate.js`` plus the shape checks that
``hnflow_author create`` / ``validate`` perform first. Two things it cannot know
offline become warnings: the host's preset allowlist and the machine's model
layers. The plugin's own ``hnflow_author validate`` stays authoritative.

Pure standard library; no HNFlow code is imported.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

SUPPORTED_KEYWORDS = (
    "type",
    "properties",
    "required",
    "additionalProperties",
    "items",
    "enum",
    "const",
    "oneOf",
)
JSON_TYPES = ("object", "array", "string", "number", "integer", "boolean", "null")
NODE_TYPES = ("agent", "judge", "merge", "gate", "request", "verify")
GATE_DECISIONS = ("approved", "rejected", "modified")
EDGE_WHEN_KINDS = ("always", "status", "verdict", "gate", "artifact.accepted")
VERDICTS = ("accept", "reject", "needs_more")
STATUSES = ("done", "failed", "skipped")
REJECT_KINDS = ("return", "fallback", "arbitrate", "fail")
DEFAULT_PRESETS = ("hnflow", "standard")
NODE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")

VERDICT_SCHEMA = {
    "type": "object",
    "required": ["verdict", "reasons"],
    "properties": {
        "verdict": {"type": "string", "enum": list(VERDICTS)},
        "reasons": {"type": "array", "items": {"type": "string"}},
        "conditions": {"type": "array", "items": {"type": "string"}},
    },
    "additionalProperties": False,
}

GATE_OUTPUT_SCHEMA = {
    "type": "object",
    "required": ["decision"],
    "properties": {
        "decision": {"type": "string", "enum": list(GATE_DECISIONS)},
        "reason": {"type": "string"},
        "decidedAt": {"type": "string"},
    },
    "additionalProperties": False,
}


@dataclass
class Issue:
    """One finding with a stable code (same codes the plugin uses)."""

    code: str
    message: str
    node_id: str | None = None
    edge_id: str | None = None

    def as_dict(self) -> dict[str, str]:
        """Serialize to the plugin's error shape."""
        data = {"code": self.code, "message": self.message}
        if self.node_id is not None:
            data["nodeId"] = self.node_id
        if self.edge_id is not None:
            data["edgeId"] = self.edge_id
        return data


@dataclass
class Report:
    """Collected errors and warnings."""

    errors: list[Issue] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        """Whether the definition passed every check."""
        return not self.errors

    def as_dict(self) -> dict[str, Any]:
        """Serialize for ``--json``."""
        return {
            "ok": self.ok,
            "errors": [issue.as_dict() for issue in self.errors],
            "warnings": list(self.warnings),
        }


def _type_of(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return "integer" if isinstance(value, int) else "number"
    if isinstance(value, list):
        return "array"
    if isinstance(value, dict):
        return "object"
    return "string"


def _declared_output(node: dict[str, Any]) -> dict[str, Any]:
    kind = node.get("type")
    if kind in ("agent", "merge"):
        output = node.get("output")
        return output if isinstance(output, dict) else {"type": "object"}
    if kind == "judge":
        return VERDICT_SCHEMA
    if kind == "gate":
        return GATE_OUTPUT_SCHEMA
    if kind == "request":
        deliverable = node.get("deliverable")
        return deliverable if isinstance(deliverable, dict) else {"type": "object"}
    if kind == "verify":
        return {
            "type": "object",
            "required": ["accepted", "violations"],
            "properties": {
                "accepted": {"type": "boolean"},
                "violations": {"type": "array", "items": {"type": "object"}},
                "judged": {"type": "boolean"},
            },
            "additionalProperties": False,
        }
    return {"type": "object"}


def _nodes_of(flow: dict[str, Any]) -> dict[str, dict[str, Any]]:
    nodes: dict[str, dict[str, Any]] = {}
    for node in flow.get("nodes") or []:
        if isinstance(node, dict) and isinstance(node.get("id"), str):
            nodes[node["id"]] = node
    return nodes


def _incoming(flow: dict[str, Any], node_id: str) -> list[dict[str, Any]]:
    return [edge for edge in flow.get("edges") or [] if isinstance(edge, dict) and edge.get("to") == node_id]


def _outgoing(flow: dict[str, Any], node_id: str) -> list[dict[str, Any]]:
    return [edge for edge in flow.get("edges") or [] if isinstance(edge, dict) and edge.get("from") == node_id]


def _ancestors(flow: dict[str, Any], node_id: str) -> set[str]:
    found: set[str] = set()
    queue = [edge.get("from") for edge in _incoming(flow, node_id)]
    while queue:
        current = queue.pop()
        if not isinstance(current, str) or current in found:
            continue
        found.add(current)
        queue.extend(edge.get("from") for edge in _incoming(flow, current))
    return found


def _deep_equal(left: Any, right: Any) -> bool:
    if isinstance(left, bool) or isinstance(right, bool):
        return left is right
    if isinstance(left, dict) and isinstance(right, dict):
        return left.keys() == right.keys() and all(_deep_equal(left[key], right[key]) for key in left)
    if isinstance(left, list) and isinstance(right, list):
        return len(left) == len(right) and all(_deep_equal(a, b) for a, b in zip(left, right))
    return left == right


class _Checker:
    """State for one definition's checks."""

    def __init__(self, definition: Any) -> None:
        self.definition = definition
        self.report = Report()
        self.nodes: dict[str, dict[str, Any]] = {}

    def fail(self, code: str, message: str, node_id: str | None = None, edge_id: str | None = None) -> None:
        self.report.errors.append(Issue(code, message, node_id, edge_id))

    # -- schema subset -------------------------------------------------
    def check_schema(self, schema: Any, path: str, node_id: str | None = None, required: bool = False) -> None:
        if schema is None:
            if required:
                self.fail("definition-invalid", f"{path} is required", node_id)
            return
        self._schema_node(schema, path, node_id)
        top = schema if isinstance(schema, dict) else {}
        if top.get("type") != "object":
            self.fail("schema-unsupported", f'{path}: the top-level schema must be type "object"', node_id)

    def _schema_node(self, schema: Any, path: str, node_id: str | None) -> None:
        if not isinstance(schema, dict):
            self.fail("schema-invalid", f"{path}: a schema must be an object", node_id)
            return
        for key in schema:
            if key not in SUPPORTED_KEYWORDS:
                self.fail(
                    "schema-unsupported",
                    f'{path}: keyword "{key}" is outside the supported subset ({", ".join(SUPPORTED_KEYWORDS)})',
                    node_id,
                )
        kind = schema.get("type")
        if kind is not None and kind not in JSON_TYPES:
            self.fail("schema-invalid", f"{path}.type: unknown type {kind!r}", node_id)
        if kind is not None and "oneOf" in schema:
            self.fail("schema-unsupported", f"{path}: a schema cannot declare both type and oneOf", node_id)
        if kind == "object":
            properties = schema.get("properties")
            if properties is not None:
                if not isinstance(properties, dict):
                    self.fail("schema-invalid", f"{path}.properties must be an object", node_id)
                else:
                    for name, child in properties.items():
                        self._schema_node(child, f"{path}.properties.{name}", node_id)
            required = schema.get("required")
            if required is not None and (not isinstance(required, list) or any(not isinstance(item, str) for item in required)):
                self.fail("schema-invalid", f"{path}.required must be an array of strings", node_id)
            additional = schema.get("additionalProperties")
            if additional is not None and not isinstance(additional, bool):
                self.fail("schema-unsupported", f"{path}.additionalProperties: only a boolean is supported", node_id)
        if kind == "array" and schema.get("items") is not None:
            self._schema_node(schema["items"], f"{path}.items", node_id)
        if "enum" in schema and not isinstance(schema["enum"], list):
            self.fail("schema-invalid", f"{path}.enum must be an array", node_id)
        if "oneOf" in schema:
            branches = schema["oneOf"]
            if not isinstance(branches, list) or not branches:
                self.fail("schema-invalid", f"{path}.oneOf must be a non-empty array", node_id)
            else:
                for index, branch in enumerate(branches):
                    self._schema_node(branch, f"{path}.oneOf[{index}]", node_id)

    # -- contracts -----------------------------------------------------
    def assignable(self, upstream: Any, downstream: Any, node_id: str | None, edge_id: str | None) -> None:
        violations = _assign_violations(upstream, downstream)
        if violations:
            first = violations[0]
            self.fail(
                "contract-unsatisfiable",
                f"upstream produces {first['actual']} at {first['path']} but downstream expects {first['expected']}",
                node_id,
                edge_id,
            )

    # -- main ----------------------------------------------------------
    def run(self) -> Report:
        definition = self.definition
        if not isinstance(definition, dict):
            self.fail("definition-invalid", "the definition must be a JSON object")
            return self.report
        if not isinstance(definition.get("flow"), dict):
            self.fail("definition-invalid", "definition.flow must be an object")
            return self.report
        flow = definition["flow"]
        if not isinstance(flow.get("id"), str) or not flow["id"].strip():
            self.fail("definition-invalid", "definition.flow.id must be a non-empty string (hnflow_author create requires it)")
        if not isinstance(flow.get("name"), str) or not flow["name"].strip():
            self.fail("definition-invalid", "definition.flow.name must be a non-empty string")
        nodes = definition.get("nodes")
        if not isinstance(nodes, list) or not nodes:
            self.fail("definition-invalid", "definition.nodes must be a non-empty array")
            return self.report
        if not isinstance(definition.get("edges"), list):
            self.fail("definition-invalid", "definition.edges must be an array")
            return self.report
        if definition.get("input") is not None:
            self.check_schema(definition["input"], "definition.input")

        self.nodes = _nodes_of(definition)
        self._check_nodes()
        self._check_edges()
        self._check_gate_branches()
        self._check_inputs_bound()
        self._check_judges()
        self._check_graph()
        return self.report

    def _check_nodes(self) -> None:
        seen: set[str] = set()
        for node in self.definition["nodes"]:
            if not isinstance(node, dict):
                self.fail("definition-invalid", "every node must be an object")
                continue
            node_id = node.get("id")
            if not isinstance(node_id, str) or not NODE_ID.match(node_id):
                self.fail("node-id-invalid", f"node id {node_id!r} must match {NODE_ID.pattern}", None)
                continue
            if node_id in seen:
                self.fail("node-id-invalid", f"duplicate node id {node_id}", node_id)
                continue
            seen.add(node_id)
            kind = node.get("type")
            if kind not in NODE_TYPES:
                self.fail("node-type-invalid", f"node {node_id} has unknown type {kind!r}", node_id)
                continue
            self.check_schema(node.get("input"), f"{node_id}.input", node_id)
            model = node.get("model")
            if model is not None:
                if not isinstance(model, str) or not model.strip():
                    self.fail("definition-invalid", f"node {node_id}.model must be a non-empty layer id", node_id)
                else:
                    self.report.warnings.append(
                        f"node {node_id} pins model layer {model}; offline lint cannot verify the layer exists"
                    )
            if kind == "agent":
                self._check_agent_like(node, node_id)
                self.check_schema(node.get("output"), f"{node_id}.output", node_id, required=True)
                self._check_budget(node, node_id)
                if "allowHuman" in node and not isinstance(node["allowHuman"], bool):
                    self.fail("definition-invalid", f"agent {node_id}.allowHuman must be a boolean", node_id)
                self._check_reject(node, node_id)
            elif kind == "judge":
                self._check_agent_like(node, node_id)
                if not isinstance(node.get("criteria"), str) or not node["criteria"].strip():
                    self.fail("definition-invalid", f"judge {node_id} needs criteria", node_id)
            elif kind == "merge":
                self._check_merge(node, node_id)
            elif kind == "gate":
                if "title" in node and not isinstance(node["title"], str):
                    self.fail("definition-invalid", f"gate {node_id}.title must be a string", node_id)
                if "detail" in node and not isinstance(node["detail"], str):
                    self.fail("definition-invalid", f"gate {node_id}.detail must be a string", node_id)
                self._check_deadline(node, node_id)
                self._check_expire(node, node_id)
            elif kind == "request":
                self.check_schema(node.get("deliverable"), f"{node_id}.deliverable", node_id, required=True)
                if not isinstance(node.get("whyHuman"), str) or not node["whyHuman"].strip():
                    self.fail("request-contract-missing", f"request {node_id} must state whyHuman", node_id)
                self._check_deadline(node, node_id)
                self._check_expire(node, node_id)
                self._check_reject(node, node_id)
            elif kind == "verify":
                self._check_verify(node, node_id)
            if kind not in ("agent", "judge") and "preset" in node:
                self.fail(
                    "definition-invalid",
                    f"node {node_id} of type {kind} cannot name a preset",
                    node_id,
                )
            for preset in self._presets_of(node):
                if preset not in DEFAULT_PRESETS:
                    self.report.warnings.append(
                        f"node {node_id} names preset {preset}; offline lint only assumes the default allowlist "
                        f"({', '.join(DEFAULT_PRESETS)}) — the host allowlist decides"
                    )

    def _check_agent_like(self, node: dict[str, Any], node_id: str) -> None:
        preset = node.get("preset")
        if not isinstance(preset, str) or not preset.strip():
            self.fail("definition-invalid", f"node {node_id} needs a preset", node_id)
        instruction = node.get("instruction")
        if not isinstance(instruction, str) or not instruction.strip():
            self.fail("definition-invalid", f"node {node_id} needs an instruction", node_id)

    def _check_merge(self, node: dict[str, Any], node_id: str) -> None:
        sources = node.get("from")
        if not isinstance(sources, list):
            self.fail("definition-invalid", f"merge {node_id} needs a from array", node_id)
            sources = []
        for source in sources:
            if not isinstance(source, str) or source not in self.nodes:
                self.fail("definition-invalid", f"merge {node_id} reads unknown node {source!r}", node_id)
        constant = node.get("set")
        if not sources and not (isinstance(constant, dict) and constant):
            self.fail("definition-invalid", f"merge {node_id} needs at least one from source or a non-empty set", node_id)
        if constant is not None:
            if not isinstance(constant, dict):
                self.fail("definition-invalid", f"merge {node_id}.set must be an object", node_id)
            else:
                for key in constant:
                    if not key.strip():
                        self.fail("definition-invalid", f"merge {node_id}.set has an empty key", node_id)
        mapping = node.get("map")
        if mapping is not None:
            if not isinstance(mapping, dict):
                self.fail("merge-map-invalid", f"merge {node_id}.map must be an object", node_id)
            else:
                allowed = {source for source in sources if isinstance(source, str)}
                for target, source in mapping.items():
                    if not str(target).strip():
                        self.fail("merge-map-invalid", f"merge {node_id}.map has an empty target name", node_id)
                        continue
                    if not isinstance(source, str) or not source.strip():
                        self.fail("merge-map-invalid", f"merge {node_id}.map.{target} must be a non-empty source path", node_id)
                        continue
                    root = source.split(".")[0]
                    if root not in allowed:
                        self.fail(
                            "merge-map-invalid",
                            f"merge {node_id}.map.{target} reads {root}, which is not one of [{', '.join(sorted(allowed))}]",
                            node_id,
                        )
                    elif any(not part.strip() for part in source.split(".")[1:]):
                        self.fail("merge-map-invalid", f"merge {node_id}.map.{target} has an empty path segment", node_id)
        self.check_schema(node.get("output"), f"{node_id}.output", node_id, required=True)

    def _check_deadline(self, node: dict[str, Any], node_id: str) -> None:
        deadline = node.get("deadline")
        if deadline is None:
            return
        if not isinstance(deadline, dict):
            self.fail("definition-invalid", f"{node.get('type')} {node_id}.deadline must be an object", node_id)
            return
        hours = deadline.get("hours")
        if hours is not None and (not isinstance(hours, (int, float)) or hours <= 0):
            self.fail("definition-invalid", f"{node.get('type')} {node_id}.deadline.hours must be a positive number", node_id)

    def _check_expire(self, node: dict[str, Any], node_id: str) -> None:
        policy = node.get("onExpire")
        if policy is not None and policy not in ("remind", "fail"):
            self.fail("definition-invalid", f"{node.get('type')} {node_id}.onExpire must be \"remind\" or \"fail\"", node_id)

    def _check_reject(self, node: dict[str, Any], node_id: str) -> None:
        policy = node.get("onReject")
        if policy is None:
            return
        if not isinstance(policy, dict):
            self.fail("reject-policy-invalid", f"{node.get('type')} {node_id}.onReject must be an object", node_id)
            return
        if policy.get("kind") not in REJECT_KINDS:
            self.fail(
                "reject-policy-invalid",
                f"{node.get('type')} {node_id}.onReject.kind must be return, fallback, arbitrate or fail",
                node_id,
            )
        attempts = policy.get("maxAttempts")
        if attempts is not None and (not isinstance(attempts, int) or isinstance(attempts, bool) or attempts < 1):
            self.fail("reject-policy-invalid", f"{node.get('type')} {node_id}.onReject.maxAttempts must be a positive integer", node_id)

    def _check_budget(self, node: dict[str, Any], node_id: str) -> None:
        budget = node.get("budget")
        if budget is None:
            return
        if not isinstance(budget, dict):
            self.fail("definition-invalid", f"node {node_id}.budget must be an object", node_id)
            return
        attempts = budget.get("maxAttempts")
        if attempts is not None and (not isinstance(attempts, int) or isinstance(attempts, bool) or attempts < 1):
            self.fail("definition-invalid", f"node {node_id}.budget.maxAttempts must be a positive integer", node_id)
        timeout = budget.get("timeoutMs")
        if timeout is not None and (not isinstance(timeout, (int, float)) or timeout <= 0):
            self.fail("definition-invalid", f"node {node_id}.budget.timeoutMs must be a positive number", node_id)

    def _check_verify(self, node: dict[str, Any], node_id: str) -> None:
        target = self.nodes.get(node.get("against"))
        if target is None:
            self.fail("definition-invalid", f"verify {node_id} references unknown node {node.get('against')!r}", node_id)
        elif target.get("type") != "request":
            self.fail("definition-invalid", f"verify {node_id} must verify a request node, not {target.get('type')}", node_id)
        checks = node.get("checks", ["schema"])
        if not isinstance(checks, list) or any(check not in ("schema", "judge") for check in checks):
            self.fail("definition-invalid", f'verify {node_id}.checks must be a subset of ["schema","judge"]', node_id)
        judge = node.get("judge")
        if isinstance(checks, list) and "judge" in checks:
            if not isinstance(judge, dict) or not isinstance(judge.get("preset"), str):
                self.fail("definition-invalid", f"verify {node_id} declares the judge check without judge.preset", node_id)
        if isinstance(judge, dict):
            model = judge.get("model")
            if model is not None and (not isinstance(model, str) or not model.strip()):
                self.fail("definition-invalid", f"verify {node_id}.judge.model must be a non-empty layer id", node_id)
        inconclusive = node.get("onInconclusive")
        if inconclusive is not None and inconclusive not in ("gate", "fail"):
            self.fail("definition-invalid", f'verify {node_id}.onInconclusive must be "gate" or "fail"', node_id)
        self._check_reject(node, node_id)

    def _check_edges(self) -> None:
        for index, edge in enumerate(self.definition["edges"]):
            if not isinstance(edge, dict):
                self.fail("definition-invalid", f"edge #{index + 1} must be an object")
                continue
            edge_id = edge.get("id") if isinstance(edge.get("id"), str) and edge["id"] else f"#{index + 1}"
            source_id = edge.get("from")
            target_id = edge.get("to")
            if not isinstance(source_id, str) or source_id not in self.nodes:
                self.fail("edge-invalid", f"edge {edge_id} leaves unknown node {source_id!r}", None, edge_id)
                continue
            if not isinstance(target_id, str) or target_id not in self.nodes:
                self.fail("edge-invalid", f"edge {edge_id} enters unknown node {target_id!r}", None, edge_id)
                continue
            when = edge.get("when", {"kind": "always"})
            if not isinstance(when, dict) or when.get("kind") not in EDGE_WHEN_KINDS:
                self.fail("edge-invalid", f"edge {edge_id}.when.kind must be one of {', '.join(EDGE_WHEN_KINDS)}", None, edge_id)
            elif not _when_value_valid(when):
                self.fail("edge-invalid", f"edge {edge_id}.when.is is not valid for kind {when.get('kind')}", None, edge_id)
            policy = edge.get("onFail")
            if policy is not None:
                if not isinstance(policy, dict) or policy.get("kind") not in ("block", "skip", "fallback"):
                    self.fail("edge-invalid", f"edge {edge_id}.onFail.kind must be block, skip or fallback", None, edge_id)
                elif policy.get("kind") == "fallback" and (not isinstance(policy.get("node"), str) or policy["node"] not in self.nodes):
                    self.fail("edge-invalid", f"edge {edge_id}.onFail names unknown fallback node {policy.get('node')!r}", None, edge_id)
            if edge.get("accepts") is not None:
                self.check_schema(edge["accepts"], f"{edge_id}.accepts", None)
            source = self.nodes[source_id]
            target = self.nodes[target_id]
            downstream = edge.get("accepts") if edge.get("accepts") is not None else target.get("input")
            if downstream is not None:
                self.assignable(_declared_output(source), downstream, target_id, edge_id)

    def _check_gate_branches(self) -> None:
        for node_id, node in self.nodes.items():
            if node.get("type") != "gate":
                continue
            outgoing = _outgoing(self.definition, node_id)
            if not outgoing:
                continue
            covered = {
                edge.get("when", {}).get("is")
                for edge in outgoing
                if isinstance(edge.get("when"), dict) and edge["when"].get("kind") == "gate"
            }
            missing = [decision for decision in GATE_DECISIONS if decision not in covered]
            if missing:
                self.fail("gate-branches-incomplete", f"gate {node_id} does not route {', '.join(missing)}", node_id)

    def _check_inputs_bound(self) -> None:
        flow_input = self.definition.get("input")
        flow_props = flow_input.get("properties") if isinstance(flow_input, dict) else None
        flow_props = flow_props if isinstance(flow_props, dict) else {}
        for node_id, node in self.nodes.items():
            declared = node.get("input")
            required = declared.get("required") if isinstance(declared, dict) else None
            if not isinstance(required, list):
                continue
            incoming = _incoming(self.definition, node_id)
            for name in required:
                if not incoming:
                    if name not in flow_props:
                        self.fail("input-unbound", f"node {node_id} requires input.{name} but the flow does not provide it", node_id)
                    continue
                provided = False
                for edge in incoming:
                    source = self.nodes.get(edge.get("from"))
                    if source is None:
                        continue
                    produced = _declared_output(source)
                    produced_props = produced.get("properties")
                    produced_props = produced_props if isinstance(produced_props, dict) else {}
                    if name in produced_props:
                        provided = True
                        break
                    if produced.get("additionalProperties") is not False:
                        accepts = edge.get("accepts")
                        accepts_props = accepts.get("properties") if isinstance(accepts, dict) else None
                        if accepts is None or not isinstance(accepts_props, dict) or name in accepts_props:
                            provided = True
                            break
                if not provided:
                    self.fail("input-unbound", f"node {node_id} requires input.{name} but no incoming edge produces it", node_id)

    def _check_judges(self) -> None:
        for node_id, node in self.nodes.items():
            judge = node.get("judge") if node.get("type") == "verify" else None
            judge_preset = node.get("preset") if node.get("type") == "judge" else (judge or {}).get("preset")
            if not isinstance(judge_preset, str):
                continue
            producers = {
                self.nodes[ancestor].get("preset")
                for ancestor in _ancestors(self.definition, node_id)
                if self.nodes[ancestor].get("type") == "agent"
            }
            if judge_preset in producers:
                self.fail("judge-same-as-producer", f"judge {node_id} uses preset {judge_preset}, the same preset as its producer", node_id)

    def _check_graph(self) -> None:
        if self._has_cycle():
            return
        starts = [node_id for node_id in self.nodes if not _incoming(self.definition, node_id)]
        ends = [node_id for node_id in self.nodes if not _outgoing(self.definition, node_id)]
        if len(starts) != 1:
            self.fail("graph-shape-invalid", f"the flow must have exactly one start node, found {len(starts)} ({', '.join(starts) or 'none'})")
        if len(ends) != 1:
            self.fail("graph-shape-invalid", f"the flow must have exactly one end node, found {len(ends)} ({', '.join(ends) or 'none'})")

    def _has_cycle(self) -> bool:
        state: dict[str, str] = {}
        for start in self.nodes:
            if start in state:
                continue
            stack: list[tuple[str, int]] = [(start, 0)]
            state[start] = "visiting"
            while stack:
                node_id, index = stack[-1]
                outgoing = _outgoing(self.definition, node_id)
                if index >= len(outgoing):
                    state[node_id] = "done"
                    stack.pop()
                    continue
                edge = outgoing[index]
                stack[-1] = (node_id, index + 1)
                target = edge.get("to")
                if not isinstance(target, str) or target not in self.nodes:
                    continue
                if state.get(target) == "visiting":
                    self.fail("cycle-unsupported", f"the flow contains a cycle through {target}", target, str(edge.get("id") or ""))
                    return True
                if state.get(target) == "done":
                    continue
                state[target] = "visiting"
                stack.append((target, 0))
        return False

    def _presets_of(self, node: dict[str, Any]) -> list[str]:
        presets: list[str] = []
        if isinstance(node.get("preset"), str):
            presets.append(node["preset"])
        judge = node.get("judge")
        if node.get("type") == "verify" and isinstance(judge, dict) and isinstance(judge.get("preset"), str):
            presets.append(judge["preset"])
        return presets


def _when_value_valid(when: dict[str, Any]) -> bool:
    kind = when.get("kind")
    value = when.get("is")
    if kind == "always":
        return "is" not in when
    if kind == "status":
        return value in STATUSES
    if kind == "verdict":
        return value in VERDICTS
    if kind == "gate":
        return value in GATE_DECISIONS
    if kind == "artifact.accepted":
        return isinstance(value, bool)
    return False


def _assign_violations(upstream: Any, downstream: Any) -> list[dict[str, str]]:
    violations: list[dict[str, str]] = []

    def walk(left: Any, right: Any, path: str) -> None:
        if not isinstance(left, dict) or not isinstance(right, dict):
            return
        at = path or "contract"
        left_type = left.get("type")
        right_type = right.get("type")
        if left_type is not None and right_type is not None and left_type != right_type:
            violations.append({"path": at, "expected": right_type, "actual": left_type})
            return
        if "const" in right and left.get("const") != right["const"]:
            violations.append({"path": at, "expected": f"const {right['const']!r}", "actual": repr(left.get("const"))})
        if isinstance(right.get("enum"), list) and isinstance(left.get("enum"), list):
            missing = [entry for entry in left["enum"] if not any(_deep_equal(entry, allowed) for allowed in right["enum"])]
            if missing:
                violations.append({"path": at, "expected": f"subset of {right['enum']}", "actual": str(missing)})
        if right_type == "object" or (right_type is None and isinstance(right.get("properties"), dict)):
            right_props = right.get("properties") if isinstance(right.get("properties"), dict) else {}
            left_props = left.get("properties") if isinstance(left.get("properties"), dict) else {}
            left_open = left_type == "object" and left.get("additionalProperties") is not False
            for name in right.get("required") or []:
                if name not in left_props:
                    if not left_open:
                        violations.append({"path": f"{at}.{name}", "expected": "produced by upstream", "actual": "absent from upstream schema"})
                    continue
                walk(left_props.get(name), right_props.get(name), f"{at}.{name}")
            for name, child in right_props.items():
                if name in left_props:
                    walk(left_props[name], child, f"{at}.{name}")
        if right_type == "array" and isinstance(right.get("items"), dict) and isinstance(left.get("items"), dict):
            walk(left["items"], right["items"], f"{at}[]")

    walk(upstream, downstream, "")
    return violations


def lint_definition(definition: Any) -> Report:
    """Run every offline check on a parsed definition."""
    return _Checker(definition).run()


def lint_text(text: str, source: str = "<text>") -> Report:
    """Parse JSON text and lint it. Parse failures become ``definition-invalid``."""
    try:
        definition = json.loads(text)
    except json.JSONDecodeError as exc:
        report = Report()
        report.errors.append(Issue("definition-invalid", f"invalid JSON in {source}: {exc}"))
        return report
    return lint_definition(definition)


def lint_file(path: Path) -> Report:
    """Load a JSON file and lint it. IO and parse failures become ``definition-invalid``."""
    try:
        text = path.read_text(encoding="utf-8-sig")
    except OSError as exc:
        report = Report()
        report.errors.append(Issue("definition-invalid", f"cannot read {path}: {exc}"))
        return report
    return lint_text(text, str(path))
