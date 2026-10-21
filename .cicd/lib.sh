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

# Waits until a URL answers 2xx/3xx (first request also compiles the page in dev mode).
wait_http() {
  local url="$1" i
  for i in $(seq 1 180); do
    if curl -fsS -o /dev/null --max-time 60 "$url"; then return 0; fi
    sleep 1
  done
  echo "timed out waiting for ${url}" >&2
  tail -n 150 "${APPS_LOG}" >&2 || true
  return 1
}

# Starts site, web (console + webmail forwarder) and worker against the running stack, in the background, and waits
# for them: the same dev launcher and committed dev placeholders the tests run against locally.
APPS_LOG="${RUNNER_TEMP:-$(mktemp -d)}/anhourmail-apps.log"
apps_up() {
  step "apps (site, web, worker)"
  node scripts/dev.mjs --no-stack >"${APPS_LOG}" 2>&1 &
  APPS_PID=$!
  # Stop the dev servers when the job's script ends (matters when these scripts are run locally).
  trap 'kill "${APPS_PID}" 2>/dev/null || true' EXIT
  wait_http "http://127.0.0.1:${WEB_DEV_PORT:-43200}/sign-in"
  wait_http "http://127.0.0.1:${SITE_DEV_PORT:-43100}/"
  wait_http "http://127.0.0.1:${WEBMAIL_DEV_PORT:-43300}/"
}
