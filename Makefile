SHELL := /bin/bash
.DEFAULT_GOAL := help

.PHONY: help install test lint dev analyze-flagsmith flagsmith-setup flagsmith-setup-dry-run flagsmith-setup-sim simulate-dry-run simulate panel-profiles

help:
	@echo "install  Install Python and web dependencies"
	@echo "test     Run Python tests (including scripts), web build, and web tests"
	@echo "lint     Check Python lint (including scripts) and project formatting"
	@echo "dev      Run the API and web dev servers (Ctrl-C stops both)"
	@echo "analyze-flagsmith       Analyze recent commits in the Flagsmith API"
	@echo "flagsmith-setup          Set up Flagsmith Production for the web app"
	@echo "flagsmith-setup-dry-run  Preview Production setup using read-only API requests"
	@echo "flagsmith-setup-sim      Set up Flagsmith Development for simulations"
	@echo "simulate-dry-run         Rehearse flow_view offline with the default reviewer panel"
	@echo "simulate                 Run flow_view in the simulation environment with the default panel"
	@echo "panel-profiles          Show the default reviewer panel's traits offline"

analyze-flagsmith:
	bash examples/analyze_flagsmith.sh

flagsmith-setup:
	python3 scripts/flagsmith_setup.py

flagsmith-setup-dry-run:
	python3 scripts/flagsmith_setup.py --dry-run

flagsmith-setup-sim:
	python3 scripts/flagsmith_setup.py --environment Development

simulate-dry-run:
	cd simulator && uv run python simulate.py --experiment flow_view --panel default --dry-run

simulate:
	cd simulator && uv run python simulate.py --experiment flow_view --panel default

panel-profiles:
	cd simulator && uv run python simulate.py --panel default --profiles

install:
	cd analyzer && uv sync
	cd server && uv sync
	cd simulator && uv sync
	cd web && npm install

test:
	cd analyzer && uv run pytest
	cd server && uv run pytest
	cd server && uv run pytest ../scripts/tests
	cd simulator && uv run pytest
	cd web && npm run build
	cd web && npm test

lint:
	cd analyzer && uv run ruff check . && uv run ruff format --check .
	cd server && uv run ruff check . ../scripts && uv run ruff format --check .
	cd simulator && uv run ruff check . && uv run ruff format --check .

dev:
	@set -m; \
	trap 'kill -TERM -- -$$server_pid -$$web_pid 2>/dev/null; wait' EXIT; \
	trap 'exit 130' INT; \
	trap 'exit 143' TERM; \
	(cd server && exec uv run uvicorn app.main:app --reload --port 8787) & server_pid=$$!; \
	(cd web && exec npm run dev) & web_pid=$$!; \
	wait
