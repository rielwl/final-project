"""HTTP surface for transaction-validation-service."""
from fastapi import FastAPI
from pydantic import BaseModel, Field

from app.engine import ValidationEngine, PaymentContext

app = FastAPI(title="transaction-validation-service")
engine = ValidationEngine.from_environment()


class PaymentRequest(BaseModel):
    amountMinor: int = Field(gt=0)
    currency: str
    debtorAccount: str
    creditorAccount: str
    reference: str | None = None


@app.post("/v1/validate")
async def validate(payment: PaymentRequest, x_client_id: str = "", idempotency_key: str = ""):
    """Return the policy verdict for a single payment.

    The gateway treats any non-200 response as a decline, so this endpoint must
    never raise for a business outcome: a declined payment is still a 200.
    """
    context = PaymentContext(
        client_id=x_client_id,
        idempotency_key=idempotency_key,
        amount_minor=payment.amountMinor,
        currency=payment.currency,
        debtor_account=payment.debtorAccount,
        creditor_account=payment.creditorAccount,
    )
    verdict = await engine.evaluate(context)
    return verdict.as_dict()


@app.get("/healthz")
async def healthz():
    return {"status": "ok"}
