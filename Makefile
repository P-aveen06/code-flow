SHELL := /bin/bash
.DEFAULT_GOAL := help

.PHONY: help install test lint dev flagsmith-setup flagsmith-setup-dry-run simulate-dry-run simulate

help:
	@echo "install  Install Python and web dependencies"
	@echo "test     Run Python tests, web build, and web tests"
	@echo "lint     Check Python lint and formatting"
	@echo "dev      Run the API and web dev servers (Ctrl-C stops both)"
	@echo "flagsmith-setup          Set up demo flags in the existing code-flow project"
	@echo "flagsmith-setup-dry-run  Preview Flagsmith setup using read-only API requests"
	@echo "simulate-dry-run        Simulate 1,000 reviewers offline"
	@echo "simulate                Send 1,000 simulated reviewers to Flagsmith"

flagsmith-setup:
	python3 scripts/flagsmith_setup.py

flagsmith-setup-dry-run:
	python3 scripts/flagsmith_setup.py --dry-run

simulate-dry-run:
	cd simulator && uv run python simulate.py --dry-run --n 1000

simulate:
	cd simulator && uv run python simulate.py

install:
	cd analyzer && uv sync
	cd server && uv sync
	cd simulator && uv sync
	cd web && npm install

test:
	cd analyzer && uv run pytest
	cd server && uv run pytest
	cd simulator && uv run pytest
	cd web && npm run build
	cd web && npm test

lint:
	cd analyzer && uv run ruff check . && uv run ruff format --check .
	cd server && uv run ruff check . && uv run ruff format --check .
	cd simulator && uv run ruff check . && uv run ruff format --check .

dev:
	@set -m; \
	trap 'kill -TERM -- -$$server_pid -$$web_pid 2>/dev/null; wait' EXIT; \
	trap 'exit 130' INT; \
	trap 'exit 143' TERM; \
	(cd server && exec uv run uvicorn app.main:app --reload --port 8787) & server_pid=$$!; \
	(cd web && exec npm run dev) & web_pid=$$!; \
	wait
