"""Amount limits and funds availability."""
from __future__ import annotations

DEFAULT_PER_PAYMENT_MINOR = 1_000_000     # 10,000.00
DEFAULT_DAILY_MINOR = 5_000_000           # 50,000.00


def evaluate(context) -> list:
    from app.engine import BLOCK, RuleViolation

    violations = []
    per_payment = context.client_limits.get("per_payment_minor", DEFAULT_PER_PAYMENT_MINOR)
    daily = context.client_limits.get("daily_minor", DEFAULT_DAILY_MINOR)

    if context.amount_minor > per_payment:
        violations.append(
            RuleViolation(
                "LIMIT_PER_PAYMENT",
                BLOCK,
                f"amount {context.amount_minor} exceeds {per_payment}",
            )
        )

    if context.daily_total_minor + context.amount_minor > daily:
        violations.append(
            RuleViolation("LIMIT_DAILY", BLOCK, f"rolling 24h total would exceed {daily}")
        )

    # The ledger is the source of truth for balance; an unknown balance means an
    # unknown account, which is itself a block.
    if context.balance_minor is None or context.balance_minor < context.amount_minor:
        violations.append(RuleViolation("INSUFFICIENT_FUNDS", BLOCK, "debtor balance below amount"))

    return violations
