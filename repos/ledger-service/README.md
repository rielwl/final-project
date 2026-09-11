# ledger-service

Double-entry ledger for Acme Bank. Owns account balances, postings and the
idempotency guarantee. Written in Go.

Called by `api-gateway` to post an approved transfer, and by
`transaction-validation-service` (read-only) for balance and daily-total lookups.

## Local setup

Requires Go 1.22+ and Docker (Postgres).

```bash
go mod download
cp .env.example .env
docker compose up -d postgres
make migrate          # applies internal/db/migrations
make run              # listens on :8082
```

`make dev` chains all four steps.

## Tests

```bash
make test                              # go test ./...
go test ./internal/ledger -run Posting -v
```

Tests use an in-process SQLite shim, so Postgres is not required for `make test`.

## Validation performed here

The ledger is not the policy owner (that is `transaction-validation-service`),
but it enforces two integrity rules at write time that nothing else can:

- **Idempotency** (`internal/validation/idempotency.go`): a repeated
  `Idempotency-Key` returns the original posting instead of duplicating it.
- **Balanced entries** (`internal/ledger/posting.go`): debits must equal credits
  or the transaction is rolled back.
