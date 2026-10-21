#!/usr/bin/env bash
# RBAC harness: every route and action against the permission matrix (CLAUDE.md rules 35-36).
# shellcheck source=.cicd/lib.sh
source "$(dirname "$0")/lib.sh"
stack_up
apps_up
step "test:rbac"
npm run test:rbac
