#!/usr/bin/env bash
# Lint, format, types and repository rule checks (CLAUDE.md rules 9, 11, 12, 31-34, 46, 52).
# shellcheck source=.cicd/lib.sh
source "$(dirname "$0")/lib.sh"
ensure_env
step "lint";            npm run --silent lint
step "format";          npm run --silent format:check
step "typecheck";       npm run --silent typecheck
step "skeletons";       npm run --silent check:skeletons
step "logging";         npm run --silent check:logging
step "docs";            npm run --silent check:docs
step "audit coverage";  npm run --silent check:audit
step "local-only files"; npm run --silent check:credentials
