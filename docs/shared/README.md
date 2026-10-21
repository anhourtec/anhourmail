# docs/shared

Reusable snippets for the public docs (`docs/public`) and anything else that renders the same facts.

Facts — hostnames, ports, plan limits, prices, sending limits and DNS record templates — are **not** written
here or in `docs/public`. They live in `packages/shared` and reach the docs through MDX components registered in
`apps/site/src/components/mdx.tsx`:

| Component                                 | Renders                                                                 |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| `<Value of="imapHost" />`                 | One fact inline (see `FactKey` in `apps/site/src/components/facts.tsx`) |
| `<ClientSettingsTable />`                 | Server, port and security for mail apps, with copy buttons              |
| `<DnsRecordTable domain="example.com" />` | The DNS records a custom domain needs, with copy buttons                |
| `<PlanTable />`                           | Plans, prices and limits                                                |
| `<SendLimitsTable />`                     | Published sending limits per level                                      |

`scripts/check-docs.mjs` fails the pre-commit hook if a fact appears literally in `docs/public`, if a link points
to a missing page, or if a public page references internal docs.

Put plain-prose snippets that several pages share in this folder as `.mdx` files and import them by relative
path.
