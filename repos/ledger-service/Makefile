.PHONY: dev run test migrate lint down

dev: ## Download deps, start Postgres, migrate and run on :8082
	go mod download
	cp -n .env.example .env || true
	docker compose up -d postgres
	$(MAKE) migrate
	$(MAKE) run

run: ## Start the ledger API on :8082
	go run ./cmd/server

test: ## Unit tests, no Postgres required
	go test ./...

migrate: ## Apply SQL migrations with goose
	goose -dir internal/db/migrations postgres "$$DATABASE_URL" up

lint:
	go vet ./...

down:
	docker compose down
