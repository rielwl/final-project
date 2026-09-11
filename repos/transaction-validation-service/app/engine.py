"""Rule orchestration: the single decision point for payment policy."""
from __future__ import annotations

import os
import uuid
from dataclasses import dataclass, field

from app.clients.ledger import LedgerClient
from app.rules import currency, limits, sanctions

BLOCK = "BLOCK"
REVIEW = "REVIEW"

# Evaluation order is compliance-first; see docs/validation-rules.md.
RULE_GROUPS = (sanctions.evaluate, currency.evaluate, limits.evaluate)


@dataclass
class PaymentContext:
    client_id: str
    idempotency_key: str
    amount_minor: int
    currency: str
    debtor_account: str
    creditor_account: str
    balance_minor: int | None = None
    daily_total_minor: int = 0
    client_limits: dict = field(default_factory=dict)


@dataclass
class RuleViolation:
    code: str
    severity: str
    detail: str = ""


@dataclass
class Verdict:
    decision: str
    reasons: list[RuleViolation]
    validation_ref: str

    def as_dict(self) -> dict:
        return {
            "decision": self.decision,
            "reasons": [
                {"code": r.code, "severity": r.severity, "detail": r.detail}
                for r in self.reasons
            ],
            "validationRef": self.validation_ref,
        }


class ValidationEngine:
    """Runs every rule group and assembles a single verdict."""

    def __init__(self, ledger: LedgerClient):
        self.ledger = ledger

    @classmethod
    def from_environment(cls) -> "ValidationEngine":
        base_url = os.environ.get("LEDGER_SERVICE_URL", "http://localhost:8082")
        return cls(LedgerClient(base_url))

    async def evaluate(self, context: PaymentContext) -> Verdict:
        # Balance is fetched once and injected so that the rule functions stay
        # pure and unit-testable without network access.
        context.balance_minor = await self.ledger.balance_minor(context.debtor_account)
        context.daily_total_minor = await self.ledger.daily_total_minor(context.debtor_account)

        violations: list[RuleViolation] = []
        for group in RULE_GROUPS:
            violations.extend(group(context))

        blocked = any(v.severity == BLOCK for v in violations)
        decision = "DECLINED" if blocked else "APPROVED"
        return Verdict(decision=decision, reasons=violations, validation_ref=str(uuid.uuid4()))
