# api-gateway

Public edge for all Acme Bank payment traffic. Terminates TLS, authenticates the
caller, performs **structural** validation of the payload, and fans the request out
to the internal services (`transaction-validation-service`, `ledger-service`).

> The gateway never decides whether a transaction is *allowed*. It only decides
> whether a request is *well formed*. Business rules live in
> `transaction-validation-service`.

## Local setup

Requires Node.js 20+ and Docker (for the local Redis rate-limit store).

```bash
nvm use 20
npm ci
cp .env.example .env
docker compose up -d redis
npm run dev            # listens on :8080
```

## Tests

```bash
npm test               # unit tests
npm run test:contract  # contract tests against a stubbed validation service
```

`make bootstrap` runs the four setup steps above in one shot.

## Environment

See `.env.example`. The only values you must change locally are
`VALIDATION_SERVICE_URL` and `LEDGER_SERVICE_URL` if you are not using the
default docker-compose ports (8081 and 8082).
