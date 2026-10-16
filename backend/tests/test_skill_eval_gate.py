"""Tests for the §24.8 install-time skill eval gate (``skills/eval_gate.py``).

The gate exists to make a declared trigger-eval suite *run* at install time,
and its whole value is in the cases it refuses: a manifest that asked to pass
and did not, and a gate that could not be run at all.  Both are pinned here,
alongside the no-op path every ordinary package takes.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from deerflow.skills.eval_gate import (
    EvalGateError,
    TriggerEvalCase,
    aevaluate_trigger_cases,
    collect_trigger_cases,
    enforce_skill_eval_gate,
    gate_failures,
)
from deerflow.skills.review import eval_schema

# ── helpers ──────────────────────────────────────────────────────────────────


def _write_manifest(root: Path, name: str, payload: Any) -> None:
    evals = root / "evals"
    evals.mkdir(parents=True, exist_ok=True)
    (evals / name).write_text(json.dumps(payload), encoding="utf-8")


def _package(tmp_path: Path) -> Path:
    root = tmp_path / "my-skill"
    root.mkdir()
    (root / "SKILL.md").write_text("---\nname: my-skill\ndescription: x\n---\n", encoding="utf-8")
    return root


def _trigger_list(*cases: dict[str, Any]) -> list[dict[str, Any]]:
    return list(cases)


def _dict_suite(*cases: dict[str, Any], require_pass: bool = True) -> dict[str, Any]:
    return {"schema_version": "deerflow.eval.v1", "cases": list(cases), "require_pass": require_pass}


def _case(query: str, should_trigger: bool) -> dict[str, Any]:
    return {"query": query, "should_trigger": should_trigger}


def _run(coro: Any) -> Any:
    return asyncio.run(coro)


# ── 1. shared manifest vocabulary ────────────────────────────────────────────


class TestSharedVocabulary:
    def test_recognizes_every_documented_shape(self) -> None:
        assert eval_schema.iter_manifest_cases({"schema_version": "v1", "cases": [1]}) == ("versioned", [1])
        assert eval_schema.iter_manifest_cases({"evals": [1]}) == ("skill-creator-evals", [1])
        assert eval_schema.iter_manifest_cases([1]) == ("trigger-eval-list", [1])

    def test_versioned_manifest_without_a_case_list_is_empty_not_unknown(self) -> None:
        assert eval_schema.iter_manifest_cases({"schema_version": "v1"}) == ("versioned", [])

    def test_unrecognized_shapes_are_none(self) -> None:
        assert eval_schema.iter_manifest_cases({}) is None
        assert eval_schema.iter_manifest_cases("nope") is None
        assert eval_schema.iter_manifest_cases({"schema_version": 7}) is None

    def test_the_review_classifier_still_agrees(self) -> None:
        # The analyzer's stats and the gate's cases must come from one reading of
        # the same manifest.
        payload = {"evals": [_case("a", True), _case("b", False)]}
        aggregate, findings = eval_schema.analyze_eval_manifests({"files": [{"path": "evals/evals.json", "kind": "text", "content": json.dumps(payload)}]})
        assert findings == []
        assert aggregate["case_count"] == 2
        assert aggregate["positive_trigger_cases"] == 1
        assert aggregate["negative_trigger_cases"] == 1


# ── 2. collection ────────────────────────────────────────────────────────────


class TestCollect:
    def test_no_evals_dir_is_an_empty_suite(self, tmp_path: Path) -> None:
        suite = collect_trigger_cases(_package(tmp_path))
        assert suite.manifests == ()
        assert suite.problems == ()
        assert suite.cases == ()

    def test_reads_trigger_cases_from_a_bare_list(self, tmp_path: Path) -> None:
        root = _package(tmp_path)
        _write_manifest(root, "trigger_eval_set.json", _trigger_list(_case("do X", True), _case("do Y", False)))

        suite = collect_trigger_cases(root)

        assert len(suite.manifests) == 1
        manifest = suite.manifests[0]
        assert manifest.schema == "trigger-eval-list"
        # A bare list has nowhere to declare the gate.
        assert manifest.require_pass is False
        assert [c.utterance for c in manifest.cases] == ["do X", "do Y"]
        assert [c.should_trigger for c in manifest.cases] == [True, False]

    def test_reads_require_pass_from_a_dict_manifest(self, tmp_path: Path) -> None:
        root = _package(tmp_path)
        _write_manifest(root, "evals.json", _dict_suite(_case("do X", True)))

        suite = collect_trigger_cases(root)

        assert suite.manifests[0].require_pass is True
        assert suite.requires_pass is True

    def test_accepts_every_documented_utterance_key(self, tmp_path: Path) -> None:
        root = _package(tmp_path)
        _write_manifest(
            root,
            "evals.json",
            {
                "evals": [
                    {"query": "q", "should_trigger": True},
                    {"prompt": "p", "should_trigger": True},
                    {"input": "i", "should_trigger": True},
                    {"utterance": "u", "should_trigger": True},
                    {"task": "t", "should_trigger": True},
                    {"message": "m", "should_trigger": True},
                ]
            },
        )
        assert [c.utterance for c in collect_trigger_cases(root).cases] == ["q", "p", "i", "u", "t", "m"]

    def test_skips_cases_without_a_decidable_expectation(self, tmp_path: Path) -> None:
        root = _package(tmp_path)
        _write_manifest(
            root,
            "evals.json",
            {
                "schema_version": "v1",
                "cases": [
                    {"id": "behaviour", "prompt": "p", "expected_readiness": "publish_candidate"},
                    {"prompt": "no flag"},
                    {"should_trigger": True},
                    {"query": "ok", "should_trigger": True},
                    "not a mapping",
                ],
            },
        )

        suite = collect_trigger_cases(root)

        # A behavioural expected-readiness case is counted, never judged here.
        assert len(suite.cases) == 1
        assert suite.cases[0].utterance == "ok"
        assert len(suite.skipped) == 4
        assert all(skip.reason for skip in suite.skipped)

    def test_a_behavioural_manifest_alone_does_not_gate(self, tmp_path: Path) -> None:
        root = _package(tmp_path)
        _write_manifest(root, "evals.json", {"schema_version": "v1", "cases": [{"id": "x", "prompt": "p"}], "require_pass": True})
        suite = collect_trigger_cases(root)
        assert suite.manifests[0].require_pass is True
        # require_pass with nothing decidable is not a gate.
        assert suite.requires_pass is False

    def test_records_malformed_manifests_as_problems(self, tmp_path: Path) -> None:
        root = _package(tmp_path)
        evals = root / "evals"
        evals.mkdir()
        (evals / "broken.json").write_text("{not json", encoding="utf-8")
        _write_manifest(root, "ok.json", _dict_suite(_case("do X", True)))

        suite = collect_trigger_cases(root)

        assert len(suite.problems) == 1
        assert "broken.json" in suite.problems[0]
        # The readable manifest still contributes its cases.
        assert len(suite.cases) == 1

    def test_ignores_unrecognized_manifests(self, tmp_path: Path) -> None:
        root = _package(tmp_path)
        _write_manifest(root, "other.json", {"unrelated": True})
        suite = collect_trigger_cases(root)
        assert suite.manifests == ()
        assert suite.problems == ()


# ── 3. evaluation ────────────────────────────────────────────────────────────


class TestEvaluate:
    def _suite(self, tmp_path: Path, *, require_pass: bool = True):
        root = _package(tmp_path)
        _write_manifest(root, "evals.json", _dict_suite(_case("a", True), _case("b", False), require_pass=require_pass))
        return collect_trigger_cases(root)

    def test_decides_every_case_with_a_sync_decider(self, tmp_path: Path) -> None:
        suite = self._suite(tmp_path)

        def decider(case: TriggerEvalCase) -> bool:
            return case.utterance == "a"

        report = _run(aevaluate_trigger_cases(suite, decider))

        assert (report.total, report.passed, report.failed) == (2, 2, 0)
        assert report.decided is True
        assert report.pass_rate == 1.0

    def test_decides_with_an_async_decider(self, tmp_path: Path) -> None:
        suite = self._suite(tmp_path)

        async def decider(case: TriggerEvalCase) -> bool:
            return True

        report = _run(aevaluate_trigger_cases(suite, decider))
        assert (report.total, report.failed) == (2, 1)

    def test_records_mismatches_with_both_sides(self, tmp_path: Path) -> None:
        suite = self._suite(tmp_path)
        report = _run(aevaluate_trigger_cases(suite, lambda _case: True))

        assert report.failed == 1
        failure = report.failures[0]
        assert failure.expected is False
        assert failure.actual is True
        assert failure.case.utterance == "b"
        assert report.to_dict()["failures"][0]["path"] == "evals/evals.json"

    def test_a_judge_failure_is_recorded_not_raised(self, tmp_path: Path) -> None:
        suite = self._suite(tmp_path)

        def decider(case: TriggerEvalCase) -> bool:
            if case.utterance == "a":
                raise RuntimeError("judge exploded")
            return False

        report = _run(aevaluate_trigger_cases(suite, decider))

        # The undecidable case is excluded from the counts and reported instead,
        # so one flaky judge call cannot hide the cases that did decide.
        assert (report.total, report.passed, report.failed) == (1, 1, 0)
        assert any("judge exploded" in problem for problem in report.problems)


# ── 4. policy / gate ─────────────────────────────────────────────────────────


class TestGatePolicy:
    def test_a_package_without_evals_is_a_no_op(self, tmp_path: Path) -> None:
        report = _run(enforce_skill_eval_gate(_package(tmp_path), skill_name="my-skill"))
        assert (report.total, report.decided, report.requires_pass) == (0, False, False)

    def test_a_report_only_package_is_counted_not_judged(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        root = _package(tmp_path)
        _write_manifest(root, "trigger_eval_set.json", _trigger_list(_case("a", True)))

        import deerflow.skills.eval_judge as eval_judge

        # No manifest asked to pass -> the gate must not build a judge at all,
        # which is what keeps an ordinary install free of a model call.
        monkeypatch.setattr(eval_judge, "build_trigger_judge", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("judge must not be built")))

        report = _run(enforce_skill_eval_gate(root, skill_name="my-skill"))

        assert (report.total, report.decided, report.requires_pass) == (1, False, False)

    def test_an_explicit_decider_still_reports_on_a_report_only_package(self, tmp_path: Path) -> None:
        root = _package(tmp_path)
        _write_manifest(root, "trigger_eval_set.json", _trigger_list(_case("a", True), _case("b", False)))
        seen: list[str] = []

        def decider(case: TriggerEvalCase) -> bool:
            seen.append(case.utterance)
            return case.utterance == "a"

        report = _run(enforce_skill_eval_gate(root, skill_name="my-skill", decider=decider))

        # A caller that supplies a judge asked for a verdict: report it, but a
        # report-only manifest still never blocks.
        assert seen == ["a", "b"]
        assert (report.total, report.passed, report.failed, report.decided) == (2, 2, 0, True)
        assert report.gated_paths == ()

    def test_a_required_suite_that_passes_is_reported(self, tmp_path: Path) -> None:
        root = _package(tmp_path)
        _write_manifest(root, "evals.json", _dict_suite(_case("a", True), _case("b", False)))

        report = _run(enforce_skill_eval_gate(root, skill_name="my-skill", decider=lambda case: case.utterance == "a"))

        assert (report.total, report.passed, report.failed) == (2, 2, 0)
        assert report.gated_paths == ("evals/evals.json",)

    def test_a_required_suite_that_fails_refuses_the_install(self, tmp_path: Path) -> None:
        root = _package(tmp_path)
        _write_manifest(root, "evals.json", _dict_suite(_case("a", True), _case("b", False)))

        with pytest.raises(EvalGateError, match="failed its required trigger eval suite") as excinfo:
            _run(enforce_skill_eval_gate(root, skill_name="my-skill", decider=lambda _case: True))

        # Only the gated manifest's failure blocks, and the message names it.
        assert len(excinfo.value.failures) == 1
        assert excinfo.value.skill_name == "my-skill"
        assert "evals/evals.json#1" in str(excinfo.value)
        assert "expected not trigger but triggered" in str(excinfo.value)

    def test_a_report_only_manifest_never_blocks_even_when_it_fails(self, tmp_path: Path) -> None:
        root = _package(tmp_path)
        _write_manifest(root, "trigger_eval_set.json", _trigger_list(_case("a", True)))

        report = _run(enforce_skill_eval_gate(root, skill_name="my-skill", decider=lambda _case: False))

        # Every case failed and nothing blocked: a bare list has no place to
        # declare a gate, so it can only ever report.
        assert (report.failed, report.requires_pass, report.gated_paths) == (1, False, ())
        assert gate_failures(report) == []

    def test_a_required_gate_without_a_judge_refuses(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        root = _package(tmp_path)
        _write_manifest(root, "evals.json", _dict_suite(_case("a", True)))

        import deerflow.skills.eval_judge as eval_judge

        monkeypatch.setattr(eval_judge, "build_trigger_judge", lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("no model configured")))

        with pytest.raises(EvalGateError, match="no judge could be built"):
            _run(enforce_skill_eval_gate(root, skill_name="my-skill"))

    def test_malformed_manifests_warn_but_do_not_block(self, tmp_path: Path) -> None:
        root = _package(tmp_path)
        evals = root / "evals"
        evals.mkdir()
        (evals / "broken.json").write_text("{not json", encoding="utf-8")

        report = _run(enforce_skill_eval_gate(root, skill_name="my-skill", decider=None))

        assert report.total == 0
        assert len(report.problems) == 1


# ── 5. the model-backed trigger judge ────────────────────────────────────────


class TestTriggerJudge:
    def _env(self, monkeypatch: pytest.MonkeyPatch, content: str) -> dict[str, Any]:
        import deerflow.skills.eval_judge as eval_judge

        config = SimpleNamespace()
        captured: dict[str, Any] = {"content": content}

        class FakeModel:
            async def ainvoke(self, messages: Any, config: Any = None) -> Any:
                captured["messages"] = messages
                captured["invoke_config"] = config
                return SimpleNamespace(content=captured["content"])

        monkeypatch.setattr(eval_judge, "get_app_config", lambda: config)
        monkeypatch.setattr(eval_judge, "create_chat_model", lambda **kwargs: FakeModel())
        monkeypatch.setattr(eval_judge, "get_effective_user_id", lambda: "judge-user")
        return captured

    def test_answers_the_trigger_question(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from deerflow.skills.eval_judge import build_trigger_judge

        captured = self._env(monkeypatch, '{"trigger":true,"reason":"matches"}')
        judge = build_trigger_judge("my-skill", description="does X")

        verdict = _run(judge(TriggerEvalCase(path="evals/evals.json", index=0, utterance="please do X", should_trigger=True)))

        assert verdict is True
        # The description is what the decision is actually about, so it must
        # reach the prompt.
        prompt = captured["messages"][-1]["content"]
        assert "my-skill" in prompt
        assert "does X" in prompt
        assert "please do X" in prompt
        assert captured["invoke_config"]["run_name"] == "skill_eval_judge"

    def test_tolerates_code_fences(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from deerflow.skills.eval_judge import build_trigger_judge

        self._env(monkeypatch, '```json\n{"trigger": false, "reason": "nope"}\n```')
        judge = build_trigger_judge("my-skill")
        assert _run(judge(TriggerEvalCase("evals/evals.json", 0, "x", False))) is False

    def test_an_unusable_verdict_raises_instead_of_guessing(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from deerflow.skills.eval_judge import build_trigger_judge

        for content in ("", "I am not sure", '{"trigger": "yes"}', "[]"):
            self._env(monkeypatch, content)
            judge = build_trigger_judge("my-skill")
            with pytest.raises(ValueError, match="no usable verdict"):
                _run(judge(TriggerEvalCase("evals/evals.json", 0, "x", True)))

    def test_a_raising_judge_refuses_a_required_gate(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        root = _package(tmp_path)
        _write_manifest(root, "evals.json", _dict_suite(_case("a", True)))

        # A judge that answers nothing must not turn "required" into "advisory".
        self._env(monkeypatch, "I am not sure")

        with pytest.raises(EvalGateError, match="could not be decided") as excinfo:
            _run(enforce_skill_eval_gate(root, skill_name="my-skill"))

        assert "no usable verdict" in str(excinfo.value)

    def test_a_decider_failure_refuses_a_required_gate(self, tmp_path: Path) -> None:
        root = _package(tmp_path)
        _write_manifest(root, "evals.json", _dict_suite(_case("a", True)))

        def decider(_case: TriggerEvalCase) -> bool:
            raise RuntimeError("judge exploded")

        with pytest.raises(EvalGateError, match="could not be decided"):
            _run(enforce_skill_eval_gate(root, skill_name="my-skill", decider=decider))


# ── 6. install integration ───────────────────────────────────────────────────


class TestInstallIntegration:
    """The gate is wired into both storage install paths."""

    def test_both_install_paths_run_the_gate(self) -> None:
        from pathlib import Path as _Path

        for relative in ("storage/local_skill_storage.py", "storage/user_scoped_skill_storage.py"):
            source = (_Path("packages/harness/deerflow/skills") / relative).read_text(encoding="utf-8")
            assert "enforce_skill_eval_gate" in source, relative
            assert "from deerflow.skills.eval_gate import enforce_skill_eval_gate" in source, relative

    def test_a_gated_package_refuses_the_install_before_commit(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        """A failing required suite must stop the install, not merely log."""
        import asyncio as _asyncio

        import deerflow.skills.eval_judge as eval_judge
        from deerflow.skills.storage import local_skill_storage as module

        root = _package(tmp_path)
        _write_manifest(root, "evals.json", _dict_suite(_case("a", True)))

        # Never let an install test reach a real model.
        monkeypatch.setattr(eval_judge, "build_trigger_judge", lambda *args, **kwargs: lambda _case: False)

        class _Storage(module.LocalSkillStorage):
            def _prepare_skill_archive(self, path: Any, tmp_path: Any, custom_dir: Any, archive_path: Any) -> tuple[Path, str, Path]:
                return root, "my-skill", custom_dir / "my-skill"

            def _commit_skill_install(self, skill_dir: Any, skill_name: str, custom_dir: Any, target: Any) -> str:  # pragma: no cover - must not run
                raise AssertionError("install must not commit when the eval gate refuses")

            def _cleanup_install_tmp(self, tmp: Any) -> None:
                return None

        storage = _Storage.__new__(_Storage)
        storage._app_config = None
        storage._host_root = tmp_path / "skills"

        async def _no_scan(*args: Any, **kwargs: Any) -> None:
            return None

        monkeypatch.setattr("deerflow.skills.installer._scan_skill_archive_contents_or_raise", _no_scan)

        with pytest.raises(EvalGateError, match="failed its required trigger eval suite"):
            _asyncio.run(storage.ainstall_skill_from_archive(tmp_path / "my-skill.skill"))

    def test_a_package_without_evals_installs_unchanged(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        import asyncio as _asyncio

        from deerflow.skills.storage import local_skill_storage as module

        root = _package(tmp_path)
        committed: list[str] = []

        class _Storage(module.LocalSkillStorage):
            def _prepare_skill_archive(self, path: Any, tmp_path: Any, custom_dir: Any, archive_path: Any) -> tuple[Path, str, Path]:
                return root, "my-skill", custom_dir / "my-skill"

            def _commit_skill_install(self, skill_dir: Any, skill_name: str, custom_dir: Any, target: Any) -> str:
                committed.append(skill_name)
                return "skill-id"

            def _cleanup_install_tmp(self, tmp: Any) -> None:
                return None

        storage = _Storage.__new__(_Storage)
        storage._app_config = None
        storage._host_root = tmp_path / "skills"

        async def _no_scan(*args: Any, **kwargs: Any) -> None:
            return None

        monkeypatch.setattr("deerflow.skills.installer._scan_skill_archive_contents_or_raise", _no_scan)

        result = _asyncio.run(storage.ainstall_skill_from_archive(tmp_path / "my-skill.skill"))

        assert result["success"] is True
        assert committed == ["my-skill"]
