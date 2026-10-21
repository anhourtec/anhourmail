# Contributing to AnhourMail

Thanks for helping make AnhourMail better. Keep each change focused, prove the behaviour you changed with
tests, and make the pull request easy to review.

## Choose the right workflow

| If you want to                                          | Start here                                                                      |
| ------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Change the console, webmail, API or worker              | [Set up local development](#set-up-local-development) below                     |
| Run AnhourMail on your own server without changing code | The [self-hosting guide](https://anhourmail.com/docs/self-hosting)              |
| Improve the public docs                                 | [`docs/public`](./docs/public) (published at anhourmail.com/docs)               |
| Change plans, limits, hostnames or DNS records          | [`packages/shared`](./packages/shared) — the one source of truth                |
| Report a security problem                               | **Not an issue** — email security@anhourmail.com ([SECURITY.md](./SECURITY.md)) |

Local development and self-hosting are different paths. Development uses the root `.env` and the dev compose
profile, where every outbound message is caught by Mailpit. Do not reuse a development `.env` on a server.

## Set up local development

You need Node.js 22, npm 10 and Docker.

```bash
cp .env.example .env
npm ci
npm run dev                  # compose services + every app, with labelled output
npm run db:seed -- --demo    # demo accounts for every role; writes credentials.md (local only)
```

The dev URLs and ports are listed in the [README](./README.md#quick-start-local-development). All services bind
to `127.0.0.1` on uncommon ports; `npm run ports:check` reports clashes. `npm run dev:reset` wipes local data and
re-seeds.

The dev stack never sends real mail. Tests that need "external" delivery use Mailpit or a second local domain —
never a real address.

## Make a focused change

1. Fork the repository and create a branch whose name describes the change.
2. Reproduce the current behaviour before editing.
3. Add or update tests for the success path, the failure paths and permission denials.
4. Make the smallest change that satisfies those tests.
5. Update the docs in the same change (see below).
6. Run the full suite before opening the pull request.

## Run the checks

Every pull request must pass all of these; CI runs the same set and blocks merging on any failure.

```bash
npm run lint             # ESLint, zero warnings
npm run format:check     # Prettier
npm run typecheck        # TypeScript strict, every workspace
npm run test             # unit tests with coverage thresholds
npm run test:int         # integration tests against the compose stack
npm run test:rbac        # every route and action against the permission matrix
npm run test:e2e         # Playwright role journeys
npm run check            # skeletons, logging, docs, SPDX headers, licences
```

Run the **full** suite, not only the tests near your change. Never skip, delete or weaken a test to get green,
and never commit with `--no-verify`. If something unrelated fails, say so in the pull request with enough detail
for a reviewer to reproduce it.

## House rules

- **SPDX header on every source file.** Apps and product packages: `// SPDX-License-Identifier: AGPL-3.0-only`.
  `packages/jmap-client`, `packages/stalwart-client`, `packages/server`, `packages/config`:
  `// SPDX-License-Identifier: MIT`. `npm run check:spdx -- --fix` adds them.
- **Docs ship with the change.** A user-facing change (feature, setting, limit, price, DNS record, client setup
  step or error message) updates `docs/public` and adds a changelog entry. Architecture or behaviour changes
  update the matching doc in `docs/internal`, plus an ADR for non-trivial decisions.
- **One source of truth.** Hostnames, ports, plan limits, prices and DNS templates come from `packages/shared`.
  Never hard-code them in pages or Markdown.
- **Permissions from one matrix.** Route, permission or navigation changes update the role matrix in
  `packages/shared`, `docs/internal/roles.md`, the RBAC harness and the e2e journeys together.
- **No mail content anywhere it doesn't belong**: not in Postgres, logs, analytics, error reports or audit entries.
- **New dependencies** must pass the licence allowlist (`npm run check:licenses`); regenerate
  `THIRD_PARTY_NOTICES.md` and the credits page data in the same change (`npm run notices`).
- **Group commits by topic**, one concern each: infra, schema, auth, UI, docs. Write commit messages that say
  what changed and why.

## Open the pull request

Include:

- why the change is needed;
- what behaviour changed;
- the exact tests and checks you ran;
- any configuration, migration, security or deployment impact; and
- screenshots (light and dark, desktop and phone width) for UI changes.

Keep credentials, `.env` files, `credentials.md`, raw user data and generated secrets out of commits and pull
requests. `credentials.md` is generated by the seed script for local use only and is gitignored.

## Contributor License Agreement

Before we can merge your first pull request, you sign the [CLA](./CLA.md). The CLA Assistant bot asks you to on
the pull request; it takes one click and covers all your future contributions.

**Why we ask:** you keep the copyright to your work, and you grant Anhourtec a licence to use it — including the
right to relicense it. That lets Anhourtec offer AnhourMail under commercial licences to organisations that
can't use AGPL software. Those licences help fund development, while the public code stays AGPL-3.0 for
everyone.

## Get help

Use [GitHub issues](https://github.com/anhourtec/anhourmail/issues) for reproducible bugs and feature
discussions. Please follow the [Code of Conduct](./CODE_OF_CONDUCT.md).
