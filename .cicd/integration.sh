#!/usr/bin/env bash
# Integration tests against the real compose stack. Mail never leaves Mailpit (CLAUDE.md rule 19).
# shellcheck source=.cicd/lib.sh
source "$(dirname "$0")/lib.sh"
stack_up
step "stack:verify"; npm run --silent stack:verify
step "test:int";     npm run test:int
