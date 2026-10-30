# Security policy

AnhourMail hosts people's email. We take security reports seriously and appreciate the work of everyone who
helps keep users safe.

## Reporting a vulnerability

**Please do not open a public GitHub issue, discussion or pull request for a security problem.**

Email **security@anhourtec.com** with:

- a description of the issue and its impact;
- the steps to reproduce it, or a proof of concept against your **own** local instance;
- the affected version, commit or URL; and
- how you would like to be credited, if at all.

If you would like to encrypt your report, ask for our current PGP key in a first, non-sensitive message.

### What to expect

| Step                                  | Target                                       |
| ------------------------------------- | -------------------------------------------- |
| Acknowledgement of your report        | within 3 business days                       |
| Initial assessment and severity       | within 10 business days                      |
| Fix or mitigation for critical issues | as fast as possible, usually within 30 days  |
| Public disclosure                     | coordinated with you once a fix is available |

We will keep you updated, and we credit reporters in the release notes and transparency report unless you
prefer to stay anonymous.

## Scope

In scope:

- the code in this repository (console, webmail, marketing site, docs, worker and packages);
- the hosted service at `anhourmail.com` and its subdomains, **within the testing rules below**.

Out of scope:

- vulnerabilities in third-party software we use (report them upstream; for example, Stalwart issues go to
  [Stalwart Labs](https://github.com/stalwartlabs/stalwart/security)), unless our configuration causes them;
- reports that require a compromised device or physical access;
- missing best-practice headers or banners without a demonstrated impact;
- denial-of-service, volumetric or rate-limit-exhaustion testing;
- social engineering of Anhourtec staff or users;
- `anhourtec.com` staff mail infrastructure.

## Testing rules

- **Test against your own local instance whenever you can.** The [local development setup](./CONTRIBUTING.md)
  runs the whole stack on your machine.
- **Do not probe, scan or load-test production.** Do not run automated scanners against our servers.
- Only interact with accounts you own or have explicit permission to test. Never access, change or delete
  other people's data or mail. If you reach someone else's data by accident, stop and tell us — do not keep it.
- Never send spam, phishing or bulk mail from or to our service as part of testing.
- Give us reasonable time to fix the issue before disclosing it publicly.

## Safe harbour

If you act in good faith and follow this policy, we will consider your research authorised. We will not pursue
or support legal action against you for it, and we will work with you to understand and fix the issue quickly.
If a third party takes legal action against you for research that followed this policy, we will make it known
that your actions were authorised by us.

## Supported versions

AnhourMail is pre-release. Only the latest commit on `main` and the current hosted service receive security
fixes.
