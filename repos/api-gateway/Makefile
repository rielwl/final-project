.PHONY: bootstrap dev test lint down

bootstrap:        ## Install deps, seed env, start local dependencies
	npm ci
	cp -n .env.example .env || true
	docker compose up -d redis

dev: ## Run the gateway with hot reload on :8080
	npm run dev

test: ## Unit + contract tests
	npm test
	npm run test:contract

lint:
	npm run lint

down:
	docker compose down
