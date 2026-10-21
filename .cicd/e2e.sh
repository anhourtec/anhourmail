#!/usr/bin/env bash
# Playwright e2e role journeys, headless.
# shellcheck source=.cicd/lib.sh
source "$(dirname "$0")/lib.sh"
stack_up
step "playwright browsers"
npx playwright install --with-deps chromium
step "test:e2e"
npm run test:e2e
