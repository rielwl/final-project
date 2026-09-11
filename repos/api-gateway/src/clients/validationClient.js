const TIMEOUT_MS = 1200;

/**
 * Thin HTTP client for transaction-validation-service.
 *
 * Fail-closed: a timeout or 5xx from the validation service is treated as a
 * decline, never as an approval. Financial traffic must never be posted to the
 * ledger on an unverified verdict.
 */
export class ValidationClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl ?? "http://localhost:8081";
  }

  async validate({ idempotencyKey, clientId, payment }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(`${this.baseUrl}/v1/validate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey ?? "",
          "X-Client-Id": clientId,
        },
        body: JSON.stringify(payment),
        signal: controller.signal,
      });

      if (!response.ok) {
        return { decision: "DECLINED", reasons: [{ code: "VALIDATION_UNAVAILABLE" }] };
      }
      return await response.json();
    } catch {
      return { decision: "DECLINED", reasons: [{ code: "VALIDATION_TIMEOUT" }] };
    } finally {
      clearTimeout(timer);
    }
  }
}
