"""Presence primitives and the access decision table (N10b, §17 / §21).

Pure-function coverage: the whole "who wins" rule lives in ``decide_access``,
so these tests are the specification of the sharing policy.  The I/O half
(probing, waiting, takeover bookkeeping) is covered by
``tests/test_apps_presence_drivers.py`` and ``tests/test_workflow_app_presence.py``.
"""

from __future__ import annotations

import pytest

from deerflow.apps.presence import (
    ACCESS_PREEMPT,
    ACCESS_PROCEED,
    ACCESS_REFUSE,
    ACCESS_WAIT,
    HOLDER_HUMAN,
    HOLDER_MACHINE,
    HOLDER_UNKNOWN,
    HOLDERS,
    HUMAN_CONFLICT_FAIL,
    HUMAN_CONFLICT_PREEMPT,
    HUMAN_CONFLICT_WAIT,
    OCCUPIED_STATES,
    PRESENCE_BUSY,
    PRESENCE_HUMAN,
    PRESENCE_IDLE,
    PRESENCE_STATES,
    PRESENCE_UNKNOWN,
    SOURCE_DRIVER,
    SOURCE_NONE,
    AccessDecision,
    PresenceReport,
    decide_access,
    holder_for,
    normalize_presence_state,
    parse_presence_output,
)


class TestNormalizePresenceState:
    def test_known_states_survive_case_and_whitespace(self) -> None:
        assert normalize_presence_state("  IDLE ") == PRESENCE_IDLE
        assert normalize_presence_state("Human") == PRESENCE_HUMAN
        assert normalize_presence_state("busy") == PRESENCE_BUSY
        assert normalize_presence_state("unknown") == PRESENCE_UNKNOWN

    @pytest.mark.parametrize("value", ["", "   ", "free", "not-busy", "idle-ish", None, 3, ["idle"], {"state": "idle"}])
    def test_anything_else_is_unknown(self, value: object) -> None:
        """A broken probe must never be able to claim the app is free."""
        assert normalize_presence_state(value) == PRESENCE_UNKNOWN


class TestParsePresenceOutput:
    def test_first_token_of_first_non_empty_line(self) -> None:
        assert parse_presence_output("human\n") == PRESENCE_HUMAN
        assert parse_presence_output("\n\n  busy  \nextra info\n") == PRESENCE_BUSY
        assert parse_presence_output("idle - nothing open") == PRESENCE_IDLE

    @pytest.mark.parametrize("stdout", ["", "\n\n", "Blender 4.2\n", "open: scene.blend", "true"])
    def test_unparsable_output_is_unknown_not_idle(self, stdout: str) -> None:
        """A banner/version string must not read as "the app is free"."""
        assert parse_presence_output(stdout) == PRESENCE_UNKNOWN


class TestPresenceReport:
    def test_unknown_helper_is_honest(self) -> None:
        report = PresenceReport.unknown(detail="no probe declared")
        assert report.state == PRESENCE_UNKNOWN
        assert report.source == SOURCE_NONE
        assert report.to_dict() == {"state": PRESENCE_UNKNOWN, "detail": "no probe declared", "source": SOURCE_NONE, "observed_at": 0.0}

    def test_is_occupied_only_for_busy_and_human(self) -> None:
        assert PresenceReport(state=PRESENCE_HUMAN).is_occupied
        assert PresenceReport(state=PRESENCE_BUSY).is_occupied
        assert not PresenceReport(state=PRESENCE_IDLE).is_occupied
        assert not PresenceReport(state=PRESENCE_UNKNOWN).is_occupied
        assert OCCUPIED_STATES == {PRESENCE_BUSY, PRESENCE_HUMAN}

    def test_invalid_state_is_a_programmer_error(self) -> None:
        """Probe output is normalized first, so a bad state means *our* bug."""
        with pytest.raises(ValueError):
            PresenceReport(state="available")

    def test_report_is_frozen(self) -> None:
        report = PresenceReport(state=PRESENCE_IDLE)
        with pytest.raises(Exception):
            report.state = PRESENCE_HUMAN  # type: ignore[misc]


class TestDecideAccess:
    def test_free_application_proceeds_under_every_policy(self) -> None:
        for policy in (HUMAN_CONFLICT_FAIL, HUMAN_CONFLICT_WAIT, HUMAN_CONFLICT_PREEMPT):
            decision = decide_access(PresenceReport(state=PRESENCE_IDLE), policy=policy)
            assert decision.outcome == ACCESS_PROCEED
            assert decision.allowed
            assert not decision.presence_unknown

    @pytest.mark.parametrize("policy", [HUMAN_CONFLICT_FAIL, HUMAN_CONFLICT_WAIT, HUMAN_CONFLICT_PREEMPT])
    def test_unknown_presence_proceeds_under_every_policy_but_is_flagged(self, policy: str) -> None:
        """fail-open on ignorance is deliberate — but never silent."""
        decision = decide_access(PresenceReport.unknown(detail="no probe"), policy=policy, allow_preempt=True)
        assert decision.outcome == ACCESS_PROCEED
        assert decision.allowed
        assert decision.presence_unknown
        assert "could not be determined" in decision.reason

    @pytest.mark.parametrize("state", [PRESENCE_HUMAN, PRESENCE_BUSY])
    def test_occupied_refuses_by_default(self, state: str) -> None:
        decision = decide_access(PresenceReport(state=state))
        assert decision.outcome == ACCESS_REFUSE
        assert not decision.allowed
        assert decision.taken_over_from is None

    @pytest.mark.parametrize("state", [PRESENCE_HUMAN, PRESENCE_BUSY])
    def test_occupied_waits_when_policy_is_wait(self, state: str) -> None:
        decision = decide_access(PresenceReport(state=state), policy=HUMAN_CONFLICT_WAIT)
        assert decision.outcome == ACCESS_WAIT
        assert not decision.allowed
        assert "waiting" in decision.reason

    def test_preempt_requires_explicit_opt_in(self) -> None:
        """A declared preempt policy on an app that did not opt in must refuse."""
        decision = decide_access(PresenceReport(state=PRESENCE_HUMAN), policy=HUMAN_CONFLICT_PREEMPT, allow_preempt=False)
        assert decision.outcome == ACCESS_REFUSE
        assert "allow_preempt" in decision.reason

    def test_preempt_takes_over_when_declared(self) -> None:
        decision = decide_access(PresenceReport(state=PRESENCE_HUMAN), policy=HUMAN_CONFLICT_PREEMPT, allow_preempt=True)
        assert decision.outcome == ACCESS_PREEMPT
        assert decision.allowed
        assert decision.taken_over_from == HOLDER_HUMAN

    def test_busy_is_treated_as_occupied_by_someone_else(self) -> None:
        """The probe cannot attribute an in-flight job, so at acquire time it is not ours."""
        decision = decide_access(PresenceReport(state=PRESENCE_BUSY), policy=HUMAN_CONFLICT_PREEMPT, allow_preempt=True)
        assert decision.outcome == ACCESS_PREEMPT
        assert decision.taken_over_from == HOLDER_HUMAN

    def test_unrecognised_policy_refuses_instead_of_consenting(self) -> None:
        decision = decide_access(PresenceReport(state=PRESENCE_HUMAN), policy="anything", allow_preempt=True)
        assert decision.outcome == ACCESS_REFUSE

    def test_allow_preempt_alone_does_not_change_the_default_policy(self) -> None:
        decision = decide_access(PresenceReport(state=PRESENCE_HUMAN), policy=HUMAN_CONFLICT_FAIL, allow_preempt=True)
        assert decision.outcome == ACCESS_REFUSE

    def test_invalid_outcome_is_a_programmer_error(self) -> None:
        with pytest.raises(ValueError):
            AccessDecision(outcome="maybe", reason="", presence=PresenceReport(state=PRESENCE_IDLE))


class TestHolderFor:
    def test_free_application_is_machine_held(self) -> None:
        decision = decide_access(PresenceReport(state=PRESENCE_IDLE, source=SOURCE_DRIVER))
        assert holder_for(decision) == HOLDER_MACHINE

    def test_attaching_to_a_human_held_application_records_a_human_holder(self) -> None:
        decision = decide_access(PresenceReport(state=PRESENCE_HUMAN, source=SOURCE_DRIVER))
        assert holder_for(decision) == HOLDER_HUMAN

    def test_preemption_records_a_human_holder(self) -> None:
        decision = decide_access(PresenceReport(state=PRESENCE_HUMAN), policy=HUMAN_CONFLICT_PREEMPT, allow_preempt=True)
        assert holder_for(decision) == HOLDER_HUMAN

    def test_blind_acquisition_is_unknown_holder(self) -> None:
        decision = decide_access(PresenceReport.unknown())
        assert holder_for(decision) == HOLDER_UNKNOWN

    def test_holders_are_the_declared_set(self) -> None:
        assert HOLDERS == {HOLDER_MACHINE, HOLDER_HUMAN, HOLDER_UNKNOWN}


def test_presence_states_are_total_and_closed() -> None:
    """`decide_access` has no case for an unknown state, so keep the set closed."""
    assert PRESENCE_STATES == {"idle", "busy", "human", "unknown"}
