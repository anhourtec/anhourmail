# Architecture decision records

One decision per file, numbered, never rewritten. A later ADR supersedes an earlier one and links back. Template: Status · Context · Decision · Consequences · Alternatives.

| #                                                            | Title                                                                         | Status                                            |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------- | ------------------------------------------------- |
| [0001](0001-stalwart-via-jmap-management-api.md)             | Drive Stalwart through its JMAP management API; never fork it                 | Accepted                                          |
| [0002](0002-tenancy-in-control-plane.md)                     | Tenancy and plan limits live in our control plane                             | Accepted                                          |
| [0003](0003-jmap-webmail-behind-bff.md)                      | JMAP webmail behind a same-origin BFF, with an app./mail. host split          | Accepted                                          |
| [0004](0004-stack.md)                                        | Stack mirrors iotkinect-portal, with ESLint + Prettier, Vitest and Playwright | Accepted                                          |
| [0005](0005-repo-layout-and-licences.md)                     | Monorepo layout and licences                                                  | Accepted                                          |
| [0006](0006-consumer-vs-company-domain.md)                   | anhourmail.com for customers, anhourtec.com for staff only                    | Accepted                                          |
| [0007](0007-public-docs-fumadocs.md)                         | Public docs inside apps/site at /docs with Fumadocs                           | Accepted                                          |
| [0008](0008-ports-and-adapters.md)                           | Ports-and-adapters: code is database-independent                              | Accepted                                          |
| [0009](0009-masked-aliases-and-undelete.md)                  | Masked aliases in our control plane; undelete via trash retention             | Accepted                                          |
| [0010](0010-audit-log.md)                                    | Append-only, hash-chained audit log in the same unit of work                  | Accepted                                          |
| [0011](0011-dev-mail-isolation.md)                           | Dev mail isolation: internal network + relay to Mailpit                       | Accepted                                          |
| [0012](0012-licence-exception-general-sans.md)               | Licence exception: General Sans font (ITF Free Font License)                  | Accepted                                          |
| [0013](0013-collaboration-features-on-stalwart-community.md) | Collaboration features on Stalwart Community                                  | Accepted                                          |
| [0014](0014-folders-and-signatures.md)                       | Folders and signatures (a familiar full-depth set) on JMAP                    | Accepted                                          |
| [0015](0015-bulk-sending-add-on.md)                          | Newsletters and bulk sending as a separate paid add-on                        | Accepted                                          |
| [0016](0016-encryption-at-rest-and-security-baseline.md)     | Encryption at rest (opt-in zero-access) and security baseline                 | Accepted                                          |
| [0017](0017-dkim-rotation-and-management-api-key.md)         | DKIM fixed selectors rotated by the worker; scoped management API key         | Accepted (updated 2026-10-28)                     |
| [0018](0018-webmail-session-push-and-transport-hardening.md) | Webmail OAuth sessions, push sizing, submission transport hardening           | Accepted                                          |
| [0019](0019-sender-identity-enforcement.md)                  | Sender identity enforcement for authenticated mail                            | Accepted                                          |
| [0020](0020-app-passwords-issued-by-the-control-plane.md)    | App passwords issued by the control plane, limited per credential             | Accepted (amended 2026-10-23, updated 2026-10-28) |
| [0021](0021-free-platform-domain-addresses.md)               | Free addresses on the platform domain: rules, allowance, no reuse             | Accepted (updated 2026-10-24)                     |
| [0022](0022-profile-photos.md)                               | Profile photos stored once, re-encoded by us, served same-origin              | Accepted (updated 2026-10-29)                     |
