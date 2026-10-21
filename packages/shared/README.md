# @anhourmail/shared

The single source of truth for public facts: platform hostnames, client ports, plan limits and prices,
published sending limits and the DNS records a customer domain needs. The console, the marketing site and
the public docs import these values; none of them hard-code them (CLAUDE.md rule 32, enforced for docs by
`scripts/check-docs.mjs`).

Framework-free and browser-safe: no Node APIs, no secrets, nothing internal. Abuse-detection thresholds
and internal hostnames do **not** belong here (rule 33).
