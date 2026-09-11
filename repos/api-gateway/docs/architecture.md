# Architecture — payment submission path

```
client ──▶ api-gateway ──▶ transaction-validation-service ──▶ ledger-service
              (edge)              (business rules)              (posting)
```

## Responsibilities

| Concern                                   | Owner                            |
|-------------------------------------------|----------------------------------|
| AuthN / AuthZ of the caller                | api-gateway (`src/middleware/auth.js`) |
| Payload shape, types, required fields      | api-gateway (`src/validation/schema.js`) |
| Currency support, limits, sanctions, AML   | transaction-validation-service   |
| Balance sufficiency                        | ledger-service (queried by the validation service) |
| Idempotency / duplicate suppression        | ledger-service (`internal/validation/idempotency.go`) |
| Double-entry posting                       | ledger-service                   |

## Why validation is split in three

1. **Gateway (structural).** Rejecting a malformed body at the edge keeps garbage
   out of the internal mesh and costs one hop. No business meaning is applied here.
2. **Validation service (policy).** All monetary policy — limits, sanctioned
   counterparties, currency pairs — lives in one deployable so that compliance can
   audit a single repository. It is the only service allowed to say "declined".
3. **Ledger (integrity).** The ledger re-checks idempotency and balance at write
   time because it is the only component that can do so atomically with the write.

This is deliberate defence in depth: the validation service is authoritative for
policy, but the ledger will still refuse a posting that would break the invariant
`sum(debits) == sum(credits)` or replay an existing idempotency key.

## Request flow (happy path)

1. `POST /v1/payments` hits `src/routes/payments.js`.
2. `authenticate` attaches the caller's client id and scopes.
3. `validatePaymentPayload` checks the JSON shape only.
4. `ValidationClient.validate()` calls the validation service and waits for a verdict.
5. On `APPROVED`, the gateway calls the ledger to post the transfer and returns 201.
6. On `DECLINED`, the gateway returns 422 with the rule codes verbatim — the
   gateway never rewrites or re-interprets a decline reason.
