.PHONY: dev test lint migrate down

dev: ## Create venv, install deps, start Postgres, run the service on :8081
	python -m venv .venv
	.venv/bin/pip install -e ".[dev]"
	cp -n .env.example .env || true
	docker compose up -d postgres
	.venv/bin/alembic upgrade head
	.venv/bin/uvicorn app.main:app --reload --port 8081

test: ## Run the rule test suite (no Postgres needed)
	.venv/bin/pytest -q

lint:
	.venv/bin/ruff check app tests

migrate:
	.venv/bin/alembic upgrade head

down:
	docker compose down
