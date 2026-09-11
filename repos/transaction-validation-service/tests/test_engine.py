import pytest

from app.engine import PaymentContext, ValidationEngine


class StubLedger:
    def __init__(self, balance=10_000_000, daily=0):
        self._balance, self._daily = balance, daily

    async def balance_minor(self, account):
        return self._balance

    async def daily_total_minor(self, account):
        return self._daily


def ctx(**overrides):
    base = dict(
        client_id="acme-web",
        idempotency_key="key-1",
        amount_minor=50_000,
        currency="GBP",
        debtor_account="GB33BUKB20201555555555",
        creditor_account="FR7630006000011234567890189",
    )
    base.update(overrides)
    return PaymentContext(**base)


@pytest.mark.asyncio
async def test_approves_a_clean_payment():
    engine = ValidationEngine(StubLedger())
    verdict = await engine.evaluate(ctx())
    assert verdict.decision == "APPROVED"


@pytest.mark.asyncio
async def test_declines_over_per_payment_limit():
    engine = ValidationEngine(StubLedger())
    verdict = await engine.evaluate(ctx(amount_minor=2_000_000))
    assert verdict.decision == "DECLINED"
    assert any(r.code == "LIMIT_PER_PAYMENT" for r in verdict.reasons)


@pytest.mark.asyncio
async def test_declines_sanctioned_counterparty():
    engine = ValidationEngine(StubLedger())
    verdict = await engine.evaluate(ctx(creditor_account="DE89370400440532013000"))
    assert verdict.decision == "DECLINED"
    assert verdict.reasons[0].code == "SANCTIONS_HIT"


@pytest.mark.asyncio
async def test_reports_every_reason_not_just_the_first():
    engine = ValidationEngine(StubLedger(balance=10))
    verdict = await engine.evaluate(ctx(amount_minor=2_000_000, currency="JPY"))
    codes = {r.code for r in verdict.reasons}
    assert {"CURRENCY_UNSUPPORTED", "LIMIT_PER_PAYMENT", "INSUFFICIENT_FUNDS"} <= codes
