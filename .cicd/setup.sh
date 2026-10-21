#!/usr/bin/env bash
# Install dependencies exactly from the lockfile.
# shellcheck source=.cicd/lib.sh
source "$(dirname "$0")/lib.sh"
ensure_env
step "npm ci"
npm ci --no-audit --no-fund
