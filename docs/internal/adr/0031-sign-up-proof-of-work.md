# ADR-0031: Sign-up proof-of-work and sign-up limits instead of SMS

**Status:** Accepted 2026-11-05

## Context

Free sign-up is open (behind the firewall allow-list on pre-staging) and each Free account can claim one free
platform-domain address (ADR-0021). The intended gate was phone verification (SMS/OTP). The maintainer decided on
2026-10-29 (`09-roadmap.md` "Maintainer decisions"): **no SMS/OTP provider**. Keep console email confirmation, add a
self-hosted proof-of-work check with no third-party requests (rule 29), and tighter sign-up rate limits. Sending ramps
for new free mailboxes stay in Phase 6.

What a gate here must do: make each account cost an automated sign-up something (CPU time, addresses), stay invisible
to a person on an ordinary phone, need no CAPTCHA images or puzzles (accessibility), and add no dependency or outside
service.

## Decision

1. **Where.** Console sign-up (`POST /api/auth/sign-up/email`) only. The sign-up gate (`server/auth/sign-up-gate.ts`)
   runs in the allow-listed auth catch-all before the identity layer sees the request. It reads the body only for its
   shape (a JSON object with string `email`, `password` and `name` of sane length, at most 8 KiB), never logs or
   audits it, and leaves the values to the identity layer. The free platform-address claim is **not** gated again: it
   needs a signed-in account with a confirmed email, is one per Free account and is limited per account and per
   client address (ADR-0021 §5) — the number of accounts is what bounds abuse there, and that is what this gates.
   Email confirmation stays.
2. **Challenge.** `POST /api/sign-up/challenge` (public, `signupChallenge` tier, 404 while sign-up is closed) returns
   a stateless, signed challenge: `v1.<bits>.<expires>.<nonce>.<client binding>.<mac>`. The nonce is 16 random bytes;
   the client binding is an HMAC of the caller's client address (the one the rate limiter uses, normalised with
   `node:net`: IPv4-mapped `::ffff:0:0/96` in any spelling and NAT64 `64:ff9b::/96` become the IPv4 address, IPv6 is
   eight canonical groups; never the address itself); the MAC is HMAC-SHA-256 over the rest. The signing key is
   HKDF-SHA-256 of `BETTER_AUTH_SECRET` with its own info label (`powKeyFrom`), so there is no new secret to deploy and
   every app instance agrees. Valid 10 minutes
   (`POW_TTL_SEC`): the page solves it as it opens, before the form is filled.
3. **Work.** Find a decimal `proof` such that SHA-256(`<challenge>.<proof>`) has at least `bits` leading zero bits.
   `bits` comes from `SIGNUP_POW_BITS` (8–26), default **17**: 2^17 ≈ 131,000 hashes on average, measured at about
   550,000 hashes per second in desktop Chromium with Web Crypto, so roughly 0.25 s on a desktop and about 1–2 s on a
   mid-range phone (5–8 times slower). The solver runs in a Web Worker with the browser's Web Crypto (`crypto.subtle`,
   batched), so the page stays responsive; there is no library and nothing leaves the page.
4. **Check (server, before any account exists).** In order: headers present and well formed; MAC (constant-time);
   not expired; bound to this client address; difficulty at least today's setting (raising it refuses older,
   easier challenges); the work; then the nonce is claimed once (Redis `SET NX PX` until expiry). The claim is last,
   so only a correct proof spends a challenge. A Redis failure refuses (503, fail closed).
5. **Sign-up limits,** all fail closed (rule 14), all from the same normalised address; nothing is counted until the
   proof is accepted and the body has the right shape (so junk requests can't use up anyone's allowance):
   - **Attempts** (`signupAttempt`, 20 / hour): every sign-up that got this far, per address (an IPv6 client per /64).
     It bounds failed sign-ups (an address already in use, a refused password or name), which cost the identity layer
     work; one person mistyping a few times stays well inside it.
   - **Accounts** (`signup` 5 / hour and `signupDay` 10 / day per address; `signupNetwork` 10 / hour and
     `signupNetworkDay` 30 / day per IPv4 /24 or IPv6 /64; `signupNetwork56Day` 60 / day per IPv6 /56 and
     `signupNetwork48Day` 120 / day per IPv6 /48 — a customer is usually given a /56 or /48, so /64 alone would give
     them 256–65,536 times the limit). Taken before the identity layer runs (increment first, so concurrent sign-ups
     can't overshoot) and **given back** (`DECR`, only while the window's key exists) unless it answered 2xx — so only
     created accounts count, and a failed sign-up never uses up a shared network's allowance.
   - Defaults in `LIMITS` (`rate-limits.md`), each replaceable by a `SIGNUP_LIMIT_*` setting.
6. **Answers.** A refused proof is 400 `proof_of_work`, whatever the reason (the form solves a new challenge and
   sends once more by itself, which covers an expired challenge or a client address that changed while solving); a
   body of the wrong shape 400 `bad_request`; attempts 429 `sign_up_attempts`; accounts 429 `sign_up_limited`, both
   with `Retry-After`; the store down 503 `unavailable`. The detailed reason is only in the log and audit.
7. **Audit.** `auth.sign_up_refused`, `denied` (`proof_of_work`, `sign_up_attempts` or `sign_up_limited`), platform
   log, system actor `identity`, no target person, `meta.reason` (`expired`, `wrong_client`, `too_easy`,
   `insufficient_work`, `replayed`; `attempts_hour`; `address_hour`, `address_day`, `network_hour`, `network_day`,
   `network56_day`, `network48_day`), with the client address like every
   signed-out event and no user agent. Missing, malformed and forged proofs are only logged — anyone can send them
   without asking us for anything, the same reasoning as a bad billing-webhook signature. At most one entry per
   network (IPv4 /24, IPv6 /48) and reason per hour (a single-use key), so a flood — even one rotating addresses
   inside an IPv6 /48 — can't grow the audit chain; every refusal is logged. Successful sign-ups stay `account.created`.
8. **Page.** A status line under the form announces the check politely to screen readers, with a progress bar (the
   chance a proof would have been found by now, never 100 % before it is); "Automatic check done." when ready; a
   plain reason and "Try again" if it fails (no Web Crypto outside a secure context, the challenge endpoint
   unreachable or limited). Pressing "Create account" before it finishes waits for it ("Finishing the check…"). No
   CAPTCHA images, nothing to click.
9. **CSP.** The console policy gains `worker-src 'self'` (with `'strict-dynamic'` a same-origin worker would otherwise
   be blocked). Nothing else changes.

## Why

- **Proof-of-work over SMS:** no provider, no phone numbers stored, no cost per sign-up, no third-party request, works
  for people without a phone number we can reach.
- **The proof only raises the cost of casual abuse; the limits are the real control.** A 17-bit proof is a fraction
  of a second for native code, so anyone determined pays almost nothing for it. What it removes is the cheapest case
  (a plain script posting the form) and it makes every counted request cost something. The attempts and account
  tiers — per address and per network, counting only created accounts — are what actually bound how many accounts one
  place can make; email confirmation and the free-address allowance bound what each one yields.
- **Stateless signed challenges:** issuing one stores nothing, so the challenge endpoint can't be used to fill Redis;
  only an accepted proof writes one key, which expires with the challenge.
- **Bound to the client address:** a solved challenge can't be stockpiled and spent from many addresses. Mobile
  addresses rarely change in the seconds between solving and sending; when they do, one automatic retry covers it.
- **Counting after the proof, and only created accounts:** a neighbour on the same CGNAT, campus or /24 can't use up
  the network's account allowance with failed or junk sign-ups; only accounts actually created count. Failed attempts
  are bounded per address by their own, more generous tier.
- **Address normalisation:** without it, `::ffff:203.0.113.7`, `64:ff9b::cb00:7107` and `203.0.113.7` would be three
  clients with three allowances behind a proxy that passes IPv6 spellings through.
- **Web Crypto, one hash per call, batched:** fast enough at 17 bits and needs no code of ours that implements a hash.
  The cost is that a page served over plain http on a LAN address (dev only) has no `crypto.subtle`; the page says so.

## Consequences

- Adaptive difficulty is not built: `SIGNUP_POW_BITS` is the one knob, and a change applies to new challenges at
  once. A later option is difficulty per network (more bits for a /24 or /48 that has made many accounts recently);
  the per-network limits are the brake while it isn't.
- **Open fact (ops):** whether the production ingress serves IPv6. If it doesn't, the /64, /56 and /48 tiers never
  apply (every client is IPv4 or a mapped IPv4) and the /24 tiers carry the network limits; if it does, they matter
  from day one. Record the answer here when the production host is set up.
- **Values to set in the ops repository** (production only, unpublished if tuned): `SIGNUP_POW_BITS`,
  `SIGNUP_LIMIT_ATTEMPTS_HOUR`, `SIGNUP_LIMIT_ADDRESS_HOUR`, `SIGNUP_LIMIT_ADDRESS_DAY`, `SIGNUP_LIMIT_NETWORK_HOUR`,
  `SIGNUP_LIMIT_NETWORK_DAY`, `SIGNUP_LIMIT_NETWORK56_DAY`, `SIGNUP_LIMIT_NETWORK48_DAY`. Unset means the defaults
  above.
- A single solution's time varies (geometric): about 5 % of solves take three times the average. Acceptable at this
  difficulty; splitting the work into several smaller proofs would narrow it if needed.
- Sign-up from a dev phone over `http://<LAN IP>` can't run the check (no secure context); use `localhost` or https.
- Phone verification in ADR-0021's consequences and `03-anti-spam-and-abuse.md` is superseded by this.
- Phase 6 still owns sending ramps and the external-sending hold for new free mailboxes.

## Update (2026-11-05): built

Built as decided the same day: the signed challenge and its check in `packages/core/src/sign-up/`
(`proof-of-work.ts`, `network.ts`, `refusal.ts`), the shared solver facts in `packages/shared/src/proof-of-work.ts`,
the gate in `apps/web/src/server/auth/sign-up-gate.ts` with `POST /api/sign-up/challenge`, the Web Worker solver on the
sign-up page, the sign-up tiers in `../rate-limits.md` and `auth.sign_up_refused` in `../audit.md`; e2e
`tests/e2e/sign-up-proof.spec.ts` (solve, replay and forged proofs refused). Invite-code sign-up (ADR-0029 §8) claims
its code after the proof-of-work, before anyone is created; while sign-up is closed, the challenge (step 2's 404) is
still issued to a page that carries an invite code. The open IPv6 fact above is still open.
