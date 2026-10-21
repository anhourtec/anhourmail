#!/usr/bin/env bash
# Builds every app, every deploy image, and validates the compose file.
# shellcheck source=.cicd/lib.sh
source "$(dirname "$0")/lib.sh"
ensure_env
step "next build (all apps)"
npm run build
step "compose config"
docker compose --profile dev config --quiet
docker compose --profile ci config --quiet
sha="${GITHUB_SHA:-local}"
for target in web site worker; do
  step "docker build ${target}"
  docker build -f "deploy/Dockerfile.${target}" --build-arg "GIT_SHA=${sha}" -t "anhourmail/${target}:ci" .
done
