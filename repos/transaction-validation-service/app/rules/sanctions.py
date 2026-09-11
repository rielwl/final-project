"""Watchlist screening for the counterparty."""
from __future__ import annotations

# Loaded from Postgres in production; the literal set keeps local dev offline.
WATCHLIST = {"GB29NWBK60161331926819", "DE89370400440532013000"}
FUZZY_PREFIXES = ("GB29NWBK", "RU")


def evaluate(context) -> list:
    from app.engine import BLOCK, REVIEW, RuleViolation

    violations = []
    if context.creditor_account in WATCHLIST:
        violations.append(RuleViolation("SANCTIONS_HIT", BLOCK, "creditor on watchlist"))
        return violations

    if any(context.creditor_account.startswith(prefix) for prefix in FUZZY_PREFIXES):
        violations.append(RuleViolation("SANCTIONS_FUZZY", REVIEW, "near match, manual review"))

    return violations
