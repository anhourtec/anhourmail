# ADR-0016: Encryption at rest and security baseline

- Status: Accepted, 2026-10-21
- Related: `../12-encryption-and-security-posture.md`, `../research/encryption.md`, `../07-security.md`, ADR-0001

## Context

The maintainer wants AnhourMail to be more secure than Purelymail and honest about encryption. Mainstream providers
(Gmail, Microsoft 365) encrypt at rest with provider-held keys; customer-held keys exist only on enterprise tiers.
Purelymail encrypts mail with a password-derived key but documents no MTA-STS/DANE, no open source and S/MIME only
as "planned". On the pinned Stalwart v0.16.27, per-user OpenPGP/S/MIME encryption at rest, MTA-STS, TLS-RPT, DANE,
REQUIRETLS and TLS 1.2/1.3-only listeners are all **Community** features (schema flags + a live end-to-end test:
message body stored as `application/pkcs7-mime`, absent from the raw blob, decryptable only with the user's key).
Stalwart has no WebAuthn/passkeys.

## Decision

1. **Transport:** TLS 1.2+ only with AEAD suites on every listener; no AUTH before STARTTLS; MTA-STS (testing →
   enforce) + TLS-RPT; DANE with a DNSSEC-signed zone; outbound `optional` strategies that enforce TLS wherever the
   destination publishes MTA-STS/DANE; REQUIRETLS advertised.
2. **Provider at rest:** full-disk encryption on the mail volume with the unlock key off-disk; client-side
   encrypted, off-server backups with an offline key.
3. **Zero-access (opt-in):** Stalwart per-user encryption at rest (`x:PublicKey` + `x:AccountSettings.encryptionAtRest`
   `Aes256`, `encryptOnAppend: true`), keys generated in the browser, private key never on our servers, honest
   trade-offs shown before enabling (headers in clear, header-only server search, key loss = mail loss).
4. **Accounts:** argon2id; TOTP + WebAuthn security keys/passkeys + recovery codes in the console (better-auth);
   per-device app passwords for mail protocols; sessions page; user-visible audit.
5. **Claims discipline:** a public claim ships only with the feature, verified in production (`12` §8).

## Consequences

- No Enterprise licence needed for the security baseline.
- DNS provider must support DNSSEC (open decision) for DANE.
- Webmail needs a client-side crypto path (OpenPGP.js + WASM argon2id) and device-side body search for
  zero-access users.
- Support cannot recover mail for users who lose their private key; onboarding must make that unmistakable.

## Alternatives considered

- **Password-derived server-side keys (Purelymail model):** protects data at rest from staff while the user is
  offline, but the server holds the password at every login. Not available in Stalwart without forking (ADR-0001).
- **Zero-access by default (Proton model):** breaks IMAP/POP for most clients and server-side search; rejected as a
  default, offered as opt-in.
- **Key escrow for recovery:** defeats the purpose; rejected.
