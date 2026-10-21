# ADR-0012: Licence exception — General Sans font (ITF Free Font License)

Status: Accepted, 2026-10-21

## Context

The CI licence allowlist (`scripts/check-licenses.mjs`) accepts MIT, Apache-2.0, BSD-2/3, ISC, MPL-2.0, OFL-1.1, 0BSD, Unlicense, CC0 and GPL-family-compatible licences. Anything else fails until it is reviewed and recorded in an ADR (section 10). The display font **General Sans** (Indian Type Foundry, distributed by Fontshare) is under the **ITF Free Font License (FFL)**, which is not on the list. We use it as self-hosted `woff2` files in `packages/ui/src/fonts/`, copied from iotkinect-portal so the brand matches the other Anhourtec products (`branding.md`, `typography.md`).

## Decision

- Accept General Sans as a **reviewed exception**, recorded in `scripts/license-exceptions.json` with a reference to this ADR.
- Why it is acceptable:
  - The FFL permits free personal and commercial use.
  - Redistributing the unmodified font files as part of our apps (served to browsers for our own pages) is allowed.
  - It is a font asset, not a code dependency. It is never linked or compiled into our code, and it does not affect the AGPL/MIT licensing of our source.
- Conditions: ship the files unmodified, don't sell the font on its own, keep the licence notice in `THIRD_PARTY_NOTICES.md` and on `/credits`, and self-host (no third-party font requests, a privacy requirement).
- Self-hosters and forks inherit the same files and terms. `TRADEMARKS.md` already asks forks to rebrand; they may swap the display font.

## Consequences

- One documented non-OSI licence in the tree. CI stays green through the exception entry, and any other non-allowlisted licence still fails.
- If ITF changes the FFL terms, or a distributor (e.g. a Linux packager) objects, we switch fonts.

## Alternatives

- **Switch the display font to an OFL font** (e.g. Inter Display, Geist at weight 500, or DM Sans, which BookYourPTO uses as body). This removes the exception but breaks visual parity with the other Anhourtec products. It stays the fallback if the exception ever becomes a problem.
- Load General Sans from Fontshare's CDN: rejected (third-party request on a privacy product).
