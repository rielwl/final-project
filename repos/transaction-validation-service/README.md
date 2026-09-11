# transaction-validation-service

The authoritative owner of **payment policy** at Acme Bank. Given a well-formed
payment, it returns `APPROVED` or `DECLINED` plus machine-readable rule codes.
It is the only service permitted to decline a payment for a business reason.

Called synchronously by `api-gateway` on `POST /v1/validate`. Calls
`ledger-service` for balance lookups.

## Local setup

Requires Python 3.11+ and Docker (Postgres holds the rule configuration).

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
cp .env.example .env
docker compose up -d postgres
alembic upgrade head
uvicorn app.main:app --reload --port 8081
```

On Windows the activate step is `.venv\Scripts\activate` instead.
Or simply `make dev`, which does all of the above.

## Tests

```bash
make test
pytest tests/test_engine.py -k limits
```

The test suite runs entirely against the in-memory rule fixtures, so no Postgres
is required for `make test`.

## Where the rules live

| Rule group | Module |
|---|---|
| Per-payment and daily limits | `app/rules/limits.py` |
| Sanctions and watchlist screening | `app/rules/sanctions.py` |
| Currency pair support, cut-off times | `app/rules/currency.py` |
| Orchestration and decision assembly | `app/engine.py` |
