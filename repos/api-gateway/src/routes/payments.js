import { Router } from "express";
import { validatePaymentPayload } from "../validation/schema.js";
import { ValidationClient } from "../clients/validationClient.js";
import { LedgerClient } from "../clients/ledgerClient.js";

export const paymentsRouter = Router();

const validationClient = new ValidationClient(process.env.VALIDATION_SERVICE_URL);
const ledgerClient = new LedgerClient(process.env.LEDGER_SERVICE_URL);

/**
 * POST /v1/payments
 *
 * Structural validation happens here; business validation happens in
 * transaction-validation-service. Do not add limit, currency or sanctions
 * checks to this file — see docs/architecture.md.
 */
paymentsRouter.post("/", async (req, res, next) => {
  const problems = validatePaymentPayload(req.body);
  if (problems.length > 0) {
    return res.status(400).json({ error: "invalid_payload", problems });
  }

  const verdict = await validationClient.validate({
    idempotencyKey: req.header("Idempotency-Key"),
    clientId: req.auth.clientId,
    payment: req.body,
  });

  if (verdict.decision === "DECLINED") {
    const err = new Error("declined");
    err.status = 422;
    err.reasons = verdict.reasons;
    return next(err);
  }

  const posting = await ledgerClient.postTransfer({
    idempotencyKey: req.header("Idempotency-Key"),
    payment: req.body,
    validationRef: verdict.validationRef,
  });

  return res.status(201).json({ paymentId: posting.paymentId, status: "accepted" });
});
