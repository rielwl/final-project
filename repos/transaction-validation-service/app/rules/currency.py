"""Currency support and settlement cut-off times."""
from __future__ import annotations

from datetime import datetime, time, timezone

SUPPORTED = {"GBP", "EUR", "USD", "CHF"}
CUTOFF_UTC = {
    "GBP": time(16, 30),
    "EUR": time(15, 0),
    "USD": time(20, 0),
    "CHF": time(14, 0),
}


def evaluate(context, now: datetime | None = None) -> list:
    from app.engine import BLOCK, RuleViolation

    violations = []
    if context.currency not in SUPPORTED:
        violations.append(RuleViolation("CURRENCY_UNSUPPORTED", BLOCK, context.currency))
        return violations

    now = now or datetime.now(timezone.utc)
    cutoff = CUTOFF_UTC[context.currency]
    if now.time() > cutoff:
        violations.append(
            RuleViolation(
                "CURRENCY_CUTOFF",
                BLOCK,
                f"{context.currency} cut-off {cutoff.isoformat()} UTC has passed",
            )
        )

    return violations
