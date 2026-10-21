#!/usr/bin/env bash
# Unit tests with coverage thresholds (CLAUDE.md rule 39). No services required.
# shellcheck source=.cicd/lib.sh
source "$(dirname "$0")/lib.sh"
ensure_env
step "vitest (unit, coverage)"
npm test
