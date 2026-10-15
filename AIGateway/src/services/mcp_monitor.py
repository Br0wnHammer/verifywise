"""
Monitor-only enforcement mode for Agent Control agent keys.

An agent key with enforcement_mode = 'monitor' is evaluated against every policy
(guardrails, require_approval rules, per-key tool lists) but never blocked or
paused: the call goes through and the audit row records what would have
happened. Rate limits and the circuit breaker stay enforced, since they protect
the gateway and upstream servers rather than express policy.

Each would-be decision is an "outcome". A call can produce several; the audit
row's result_status is the most severe one and every outcome is added to the
row's events timeline.
"""

from datetime import datetime, timezone
from typing import Optional

ENFORCE = "enforce"
MONITOR = "monitor"
ENFORCEMENT_MODES = (ENFORCE, MONITOR)

WOULD_BLOCK = "would_block"
WOULD_NEED_APPROVAL = "would_need_approval"

# Most severe first.
_SEVERITY = (WOULD_BLOCK, WOULD_NEED_APPROVAL)
# What the caller would have been told, by status.
_WOULD = {WOULD_BLOCK: "deny", WOULD_NEED_APPROVAL: "approval_required"}


def is_monitor(agent_key: dict) -> bool:
    """True when the key is in monitor-only mode. A missing value means enforce."""
    return agent_key.get("enforcement_mode") == MONITOR


def outcome(
    status: str,
    reason: str,
    rule_id: Optional[int] = None,
    rule_name: Optional[str] = None,
) -> dict:
    """One would-be decision. status is WOULD_BLOCK or WOULD_NEED_APPROVAL."""
    return {"status": status, "reason": reason, "rule_id": rule_id, "rule_name": rule_name}


def most_severe(outcomes: list[dict]) -> dict:
    """The outcome that decides the audit status (the first of the most severe kind)."""
    for status in _SEVERITY:
        for o in outcomes:
            if o["status"] == status:
                return o
    raise ValueError("no outcomes")


def outcome_events(outcomes: list[dict]) -> list[dict]:
    """Events-timeline entries, one per outcome, so every outcome stays visible."""
    at = datetime.now(timezone.utc).isoformat()
    return [
        {
            "type": o["status"],
            "at": at,
            "detail": o["reason"],
            "rule_id": o["rule_id"],
            "rule_name": o["rule_name"],
        }
        for o in outcomes
    ]


def _public(o: dict) -> dict:
    rule = {"id": o["rule_id"], "name": o["rule_name"]} if o["rule_id"] is not None else None
    return {"would": _WOULD[o["status"]], "reason": o["reason"], "rule": rule}


def monitored_payload(outcomes: list[dict]) -> dict:
    """The `monitored` block returned to the caller next to an allow."""
    chosen = _public(most_severe(outcomes))
    return {**chosen, "outcomes": [_public(o) for o in outcomes]}

