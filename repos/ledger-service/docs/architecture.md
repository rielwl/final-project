# ledger-service architecture

## Storage model

Two tables: `entries` (immutable, append-only) and `accounts` (materialised
balance, updated in the same transaction as the entries).

A transfer is always two entries: one debit and one credit, sharing a
`transaction_id`. The invariant `sum(amount_minor) == 0` per `transaction_id` is
asserted in `internal/ledger/posting.go` before commit and enforced again by a
database constraint.

## Why the ledger re-validates

`api-gateway` only calls us after `transaction-validation-service` has approved a
payment, so a second policy check would be redundant. What is *not* redundant:

1. **Idempotency.** Only the component that owns the write can atomically decide
   whether a key has been used. Retries from the gateway are normal.
2. **Balance at write time.** The validation service reads the balance a few
   milliseconds earlier; a concurrent posting can invalidate it. The final
   sufficiency check happens inside the write transaction.

## Read paths used by other services

| Endpoint | Caller | Handler |
|---|---|---|
| `GET /v1/accounts/{iban}/balance` | transaction-validation-service | `internal/api/handlers.go` |
| `GET /v1/accounts/{iban}/daily-total` | transaction-validation-service | `internal/api/handlers.go` |
| `POST /v1/postings` | api-gateway | `internal/api/handlers.go` |
