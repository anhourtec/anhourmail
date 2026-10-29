# Runbooks

Each runbook covers: symptoms → impact → first five minutes → diagnosis → fix → verification → follow-up. The ones below are still to be written (Phase 6 unless noted). Runbooks that need production IPs or hostnames live in the private ops repo; this folder holds the generic procedure.

| Runbook                         | One line                                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `outbound-ip-blocklisted.md`    | Our IP appears on Spamhaus, Barracuda or Talos: stop the source, delist, warm back up                        |
| `hosting-ip-block.md`           | The hosting provider's anti-spam system blocked port 25 on our IP: find the cause, unblock, prevent a repeat |
| `postmaster-spam-rate-spike.md` | Postmaster spam rate ≥ 0.1%: find the accounts, restrict, review limits                                      |
| `compromised-account.md`        | A user's account is sending spam: lock, revoke sessions and app passwords, notify, restore                   |
| `mail-queue-backlog.md`         | The Stalwart queue is growing: diagnose deferrals, remote throttling, DNS, TLS                               |
| `stalwart-down.md`              | Stalwart is unhealthy: restart, check the store, restore from snapshot                                       |
| `stalwart-upgrade.md`           | Step-by-step upgrade from `08-operations.md`, with the verification checklist (Phase 1)                      |
| `postgres-restore.md`           | Restore the control plane from `pg_dump` / PITR (Phase 1)                                                    |
| `stalwart-restore.md`           | Restore a RocksDB snapshot or a single mailbox (Vandelay) (Phase 1)                                          |
| `monthly-restore-drill.md`      | The drill procedure and its record template                                                                  |
| `certificate-expiry.md`         | HTTP or mail certificates near expiry: ACME renewal, manual fallback                                         |
| `dns-provider-outage.md`        | Our DNS (`anhourmail.com` and the hosts under it) is down or wrong                                           |
| `reconciler-drift.md`           | Postgres and Stalwart disagree: safe re-apply, never auto-delete                                             |
| `audit-chain-break.md`          | The audit hash chain fails verification: freeze, investigate, report                                         |
| `abuse-report-handling.md`      | Working `abuse@` and the abuse queue, CASL record-keeping                                                    |
| `legal-request.md`              | Lawful access request intake, counsel review, user notice, transparency report                               |
| `severe-content.md`             | CSAM or credible threats: preserve, report, never forward content internally                                 |
| `stripe-webhook-failures.md`    | Webhooks failing or out of order: replay safely (idempotent)                                                 |
| `secret-rotation.md`            | Rotate the key ring, Stalwart API key, Stripe keys, DKIM keys                                                |
| `data-export-and-deletion.md`   | Fulfil export and deletion requests within the promised time                                                 |
| `incident-communication.md`     | Status page, user notices, PIPEDA breach assessment and OPC report                                           |
