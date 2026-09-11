/** Thin HTTP client for ledger-service. */
export class LedgerClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl ?? "http://localhost:8082";
  }

  async postTransfer({ idempotencyKey, payment, validationRef }) {
    const response = await fetch(`${this.baseUrl}/v1/postings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey ?? "",
      },
      body: JSON.stringify({ ...payment, validationRef }),
    });

    if (response.status === 409) {
      // The ledger already saw this idempotency key; return the original posting.
      return await response.json();
    }
    if (!response.ok) {
      throw new Error(`ledger_error_${response.status}`);
    }
    return await response.json();
  }
}
