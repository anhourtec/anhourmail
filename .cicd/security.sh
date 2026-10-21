#!/usr/bin/env bash
# Secret scan over the full history and a production dependency audit.
# shellcheck source=.cicd/lib.sh
source "$(dirname "$0")/lib.sh"
GITLEAKS_IMAGE="zricethezav/gitleaks:v8.30.1"
step "gitleaks (${GITLEAKS_IMAGE})"
docker run --rm -v "$PWD:/repo" -w /repo "$GITLEAKS_IMAGE" git --redact --no-banner --exit-code 1 /repo
step "npm audit (production deps, high+)"
npm audit --omit=dev --audit-level=high
