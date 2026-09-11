const REQUIRED_FIELDS = ["amountMinor", "currency", "debtorAccount", "creditorAccount"];
const ISO_CURRENCY = /^[A-Z]{3}$/;
const IBAN = /^[A-Z]{2}[0-9]{2}[A-Z0-9]{10,30}$/;

/**
 * Structural validation only: presence, type, and format of fields.
 *
 * This function deliberately knows nothing about limits, sanctioned countries or
 * supported currency pairs. A payload that passes here may still be declined by
 * transaction-validation-service.
 *
 * @returns {Array<{field: string, code: string}>} empty when the payload is well formed
 */
export function validatePaymentPayload(body) {
  const problems = [];
  if (typeof body !== "object" || body === null) {
    return [{ field: "$", code: "not_an_object" }];
  }

  for (const field of REQUIRED_FIELDS) {
    if (body[field] === undefined || body[field] === null) {
      problems.push({ field, code: "required" });
    }
  }

  if (body.amountMinor !== undefined) {
    if (!Number.isInteger(body.amountMinor)) {
      problems.push({ field: "amountMinor", code: "must_be_integer_minor_units" });
    } else if (body.amountMinor <= 0) {
      problems.push({ field: "amountMinor", code: "must_be_positive" });
    }
  }

  if (body.currency !== undefined && !ISO_CURRENCY.test(body.currency)) {
    problems.push({ field: "currency", code: "must_be_iso_4217" });
  }

  for (const field of ["debtorAccount", "creditorAccount"]) {
    if (body[field] !== undefined && !IBAN.test(String(body[field]))) {
      problems.push({ field, code: "must_be_iban" });
    }
  }

  if (body.reference !== undefined && String(body.reference).length > 140) {
    problems.push({ field: "reference", code: "too_long" });
  }

  return problems;
}
