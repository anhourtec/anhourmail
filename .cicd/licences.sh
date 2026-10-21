#!/usr/bin/env bash
# Licence allowlist, third-party notices freshness and SPDX headers (CLAUDE.md rules 42-43).
# shellcheck source=.cicd/lib.sh
source "$(dirname "$0")/lib.sh"
step "licence allowlist"; npm run --silent check:licenses
step "notices up to date"; npm run --silent check:notices
step "SPDX headers"; npm run --silent check:spdx
