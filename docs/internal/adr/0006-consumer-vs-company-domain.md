# ADR-0006: anhourmail.com for customers, anhourtec.com for staff only

Status: Accepted, 2026-10-21

## Context

A free consumer mail service attracts abuse. If customer mail shared a domain with company mail, a reputation hit from customer abuse would land on the company's own mail.

## Decision

- `anhourmail.com` is the product domain: free addresses, marketing, docs, console, webmail, mail hostnames.
- `anhourtec.com` carries staff mail only. It is never used for customer or free accounts (rule 28). It is hosted on AnhourMail itself after dogfooding, as a separate domain.
- Platform mail (notifications, waitlist confirmations) is sent from `anhourmail.com` addresses.

## Consequences

- Company reputation is insulated from consumer abuse.
- Two domains to secure (DNSSEC, MTA-STS, DMARC on both).

## Alternatives

- A single domain: rejected (shared reputation).
