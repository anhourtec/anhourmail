#!/usr/bin/env bash
# Shared helpers for .cicd scripts. Sourced, not executed.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

step() { printf '\n==> %s\n' "$*"; }

# CI uses the committed dev placeholders; real secrets never live in the repo.
ensure_env() {
  if [[ ! -f .env ]]; then
    cp .env.example .env
  fi
}

# Starts the compose services used by integration-style jobs and waits for health.
stack_up() {
  ensure_env
  step "ports"
  npm run --silent ports:check
  step "compose up (ci profile)"
  docker compose --profile ci up -d --wait
  step "migrate + seed"
  npm run --silent db:migrate
  npm run --silent db:seed
}
