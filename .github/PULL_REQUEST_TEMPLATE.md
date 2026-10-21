## Why

<!-- What problem does this solve? Link the issue if there is one. -->

## What changed

<!-- The behaviour that changed, not just the files. -->

## How it was tested

<!-- The exact commands you ran and their results. Screenshots (light + dark, 1440 + 390 wide) for UI changes. -->

## Checklist

- [ ] Full suite passes: `lint`, `format:check`, `typecheck`, `test`, `test:int`, `test:rbac`, `test:e2e`, `check`
- [ ] New and changed code has unit tests (success, failure and permission-denied paths)
- [ ] Docs updated in this change (`docs/public` + changelog for user-facing changes; `docs/internal` / ADR for design changes)
- [ ] Permission, route or nav changes update the role matrix, `docs/internal/roles.md`, the RBAC harness and e2e journeys
- [ ] Mutations write audit entries; new action names are in `docs/internal/audit.md`
- [ ] Every new source file has the correct SPDX header (`npm run check:spdx`)
- [ ] New dependencies pass `npm run check:licenses`, and `THIRD_PARTY_NOTICES.md` is regenerated
- [ ] No secrets, `.env`, `credentials.md`, production IPs, tuned abuse thresholds or mail content in the diff
- [ ] I have signed the [CLA](../CLA.md) (the CLA Assistant bot will ask on your first PR)

## Impact

<!-- Configuration, migration (with rollback level), security, deliverability or deployment impact. "None" is fine. -->
