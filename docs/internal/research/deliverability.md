# AnhourMail: Deliverability and Hosting Research

Date: 2026-10-21

Scope: v1 runs on one Canadian VPS with Stalwart (mail) and a Docker Compose app. This document covers where to host it, how to protect IP and domain reputation, and what to set up before launch.

Every claim cites a source in brackets, for example [S12]. The numbered source list is at the end. Items marked **UNVERIFIED** could not be confirmed from a primary source on 2026-10-21 and must be checked with the vendor before anyone relies on them.

---

## 1. Canadian VPS and dedicated providers

### 1.1 What v1 needs

- A data centre in Canada.
- A clean IPv4 address and an IPv6 address.
- Reverse DNS (PTR) that we can set for both.
- Outbound TCP/25 open, or opened on request.
- Terms of service that allow running a mail service.
- Ideally, a non-US owner, because a non-US owner helps the privacy positioning.

Gmail requires valid forward and reverse DNS for **all** senders, and the PTR hostname must resolve back to the sending IP [S30]. A host that cannot set PTR is therefore disqualified.

### 1.2 Provider-by-provider findings

**OVHcloud (French parent; Canadian entity OVH Hosting Inc.)**
- **Canadian locations.** VPS runs in Beauharnois, Quebec (BHS) [S2]. Beauharnois opened in 2012 [S4]. The Toronto-area site is in Cambridge, Ontario (Ascent TOR1) and opened in 2024. The Toronto-region page lists dedicated servers and Hosted Private Cloud there, but no VPS [S3][S4].
- **Port 25.** OVH runs a reactive anti-spam layer (Vade). When it detects spam from an IP, it blocks port 25 for that IP at network level. The first block in OVH's API example lasts 3600 s, and repeat offences get longer blocks. You unblock it yourself from Control Panel > Network > Public IP Addresses > "Anti-spam unblocking", or through the API [S5]. The guide says nothing about a block **by default**.
  - The forwardemail "awesome-mail-server-providers" list says port 25 is open by default at OVH, subject to anti-spam monitoring [S7].
  - A 2023 OVH community reply says "le port 25 est ouvert sur les VPS" [S6].
  - A Feb-2026 third-party guide also says it is open by default [S8].
  - One third-party review (verified 2026-04-27) says OVH VPS blocks port 25 by default with "unblocked on request". It cites only the anti-spam guide, which does not say that [S9]. **UNVERIFIED / conflicting.** Test with `nc -vz gmail-smtp-in.l.google.com 25` before committing.
- **rDNS.** Self-service for IPv4 and IPv6 in the Control Panel. The A or AAAA record must already resolve to the IP [S10].
- **IPv6.** Native IPv6 on VPS [S1].
- **Extra IPs.** Up to 16 additional IPs per VPS [S2]. This allows separate outbound IPs later (see section 8).
- **Price.** VPS-2 is 4 vCore / 8 GB / 75 GB NVMe for $11.64/mo. VPS-3 is 6 vCore / 12 GB / 100 GB NVMe for $16.83/mo. These are "from" prices on a 12-month commitment, and the currency is probably CAD but not labelled [S1][S2].
- **Reputation.** AS16276 is a huge, abuse-prone ASN. Point-in-time lookups show Beauharnois IPs on Spamhaus CSS and UCEPROTECT L1 [S11]. A community thread reports a whole /24 listed on Spamhaus and a newly assigned range already on Microsoft's blocklist [S12]. A March 2026 Register reader comment claims Outlook.com blocked OVH Europe ranges (anecdotal) [S13]. OVH documents a delisting process [S14].
- **Sovereignty.** OVH's own FAQ says it will honour lawful CLOUD Act requests and that these "could" reach data held outside the US [S15]. OVH also says only its US entity is subject to the Act. In 2025 a Canadian court ordered OVH to produce data stored in Europe under an RCMP production order [S16]. The parent is not US, but it is not immune to cross-border orders.

**Hetzner**
- **No Canadian location.** Cloud locations are Falkenstein, Nuremberg, Helsinki, Ashburn VA, Hillsboro OR and Singapore [S17]. Hetzner is excluded.

**Vultr (US, West Palm Beach)**
- **Canadian location.** Toronto.
- **Port 25.** Blocked by default on new instances. You can request an unblock by support ticket, giving your use case, protections (SPF/DKIM/rate limits) and expected volume. Approval is "not guaranteed" (doc updated 15 Apr 2026) [S18]. Forum reports vary: some approvals took minutes, others needed repeated requests per server [S19].
- **rDNS.** Self-service for IPv4 and IPv6 (/64 per instance) through the console, API, CLI or Terraform [S20].
- **Price.** Regular 4 vCPU / 8 GB / 160 GB is about US$40/mo, and High Performance is about US$48/mo. Both figures come from third-party listings; Vultr's pricing page blocked automated fetch [S21]. **UNVERIFIED.**
- **Sovereignty.** US-owned, so CLOUD Act exposure.

**DigitalOcean (US)**
- **Canadian location.** Toronto (TOR1).
- **Port 25.** Ports 25, 465 and 587 are blocked on Droplets by default, including over Reserved IPs (verified 13 Jul 2026). The docs describe no unblock process and advise against running your own mail server [S22]. Staff answers mention a 60-day wait or a flat "can't be removed" [S23]. **Unsuitable.**
- **Price.** Basic 4 vCPU / 8 GiB / 160 GiB is US$48/mo [S24].

**Akamai Cloud / Linode (US)**
- **Canadian location.** Toronto (ca-central).
- **Port 25.** Accounts created after 5 Nov 2019 have 25, 465 and 587 restricted. To lift it, first set valid A and rDNS records, then open a ticket with your name, use case, anti-abuse measures and sending domains. Staff review the request [S25][S26]. Users report support as "very helpful and quick" [S27]. A 2024 user claimed no block on a new account (anecdotal) [S27]. AUP violations can reinstate the block [S28].
- **rDNS and IPv6.** Self-service rDNS, and IPv6 is standard. The Toronto price was not verifiable from Akamai's pricing page [S29], so it is **UNVERIFIED**. Shared 8 GB / 4 CPU / 160 GB has historically been US$48.
- **Sovereignty.** US-owned.

**AWS (US): ca-central-1 Montreal, ca-west-1 Calgary**
- Calgary is AWS's 33rd region and went live by Dec 2023 [S31].
- **Port 25.** Blocked by default. The account root user must submit a per-Region "Request to remove email sending limitations" form, which also sets rDNS on Elastic IPs. AWS takes up to 48 h, and denials happen [S32][S33]. One report says ports stayed blocked through a NAT Gateway even after approval [S33].
- **Price.** Usage-based and well above VPS pricing for 8 GB. Not priced here.
- **Sovereignty.** US-owned.

**Hyperscaler A (US): Montreal, Toronto**
- **Port 25.** Egress to external TCP/25 is blocked by default. The vendor "automatically removes this block once it determines a project is at low risk". There is no formal request process; the vendor says to contact sales. The status shows as a console banner. **Unsuitable** for a v1 that must send on day 1.

**Hyperscaler B (US): Toronto, Quebec City**
- **Port 25.** Open only for Enterprise Agreement and MCA-E subscriptions. Enterprise Dev/Test can self-exempt. Port 25 is blocked for all other types, with no unblock path (doc updated 2026-07-16). **Unsuitable** for a startup on pay-as-you-go.
- **Sovereignty.** In 2025 the vendor stated it "cannot guarantee" data sovereignty against US requests.

**LunaNode (LunaNode Hosting Inc.)**
- **Canadian location.** Toronto only now. The locations page lists only Toronto [S38]. A 2023 forum post mentioned Montreal and France sites that were OVH resellers [S39].
- **Port 25.** A single forum user says it is not blocked [S39]. The FAQ and site say nothing [S40]. **UNVERIFIED.**
- **IPv6.** Supported in Toronto via SLAAC, with a /64 per user network [S40]. rDNS: not documented in the pages read.
- **Price (USD).** m.8 is 4 vCPU / 8 GB / 70 GB for $28/mo. s.8 is 8 vCPU / 8 GB / 125 GB for $56/mo [S41].
- **Ownership.** Canadian ownership is likely but **UNVERIFIED**.

**Canadian Web Hosting (iDigital Internet Inc., Vancouver)**
- **Ownership.** "100% Canadian-owned and operated", headquartered at 602 W Hastings, Vancouver [S42].
- **Canadian locations.** Data centres in downtown Vancouver, downtown Toronto and Coquitlam [S42].
- **Price.** VPS from CAD $6.95/mo on an annual term. Specs for a 4 vCPU / 8 GB plan were not published in the pages read [S42].
- **Port 25, rDNS, IPv6, mail-server ToS.** Not published. **UNVERIFIED.** Ask sales (sales@canadianwebhosting.com) for written confirmation. Being local to Vancouver/Victoria is a plus for support and for the "Canadian-owned" story.

**FullHost (Victoria, BC)**
- Data centres in Vancouver, Calgary, Toronto and Montreal, from $7/mo [S43].
- Port 25, rDNS and IPv6 are not published. **UNVERIFIED.**

**ThinkOn (Canadian sovereign cloud)**
- Claims not to be subject to foreign data-access laws, and is accredited for Protected B [S44].
- Sells only through partners, with no public pricing [S44]. Enterprise and public-sector focus, so poor fit for v1.

**Others checked**
- **Hostinger.** No Canadian VPS location [S45].
- **Whitelabel IT Solutions.** Headquartered in New Jersey; no evidence of a Vancouver data centre [S46].
- Cloud.ca, Sangoma, Netrouting and HostPapa: no evidence found that they offer a self-serve Canadian VPS with documented port-25/rDNS policies. Not pursued.

### 1.3 Comparison table

Price is for about 4 vCPU / 8 GB / 100+ GB SSD.

| Provider | Canadian DC | Port 25 outbound | rDNS self-service | IPv6 | Price | Owner / CLOUD Act | Fit |
|---|---|---|---|---|---|---|---|
| **OVHcloud VPS** | Beauharnois QC | Open by default per most sources; reactive auto-block on spam detection, self-unblock [S5][S6][S7] (one conflicting claim [S9]) | Yes, v4+v6 [S10] | Yes [S1] | VPS-2 $11.64 (75 GB) / VPS-3 $16.83 (100 GB), 12-mo [S2] | French parent; US subsidiary; Canadian court order precedent [S15][S16] | **Good** (reputation risk) |
| **Akamai/Linode** | Toronto | Blocked; ticket after A+rDNS set; generally granted [S25][S26][S27] | Yes | Yes | ~US$48 (unverified) | US | **Good** |
| **Vultr** | Toronto | Blocked; ticket, case-by-case, not guaranteed [S18] | Yes v4+v6 [S20] | Yes | ~US$40–48 (third-party) [S21] | US | OK |
| **LunaNode** | Toronto | Reportedly open (anecdotal) [S39] | Unverified | Yes [S40] | US$28 (70 GB) / $56 (125 GB) [S41] | Likely Canadian (unverified) | Candidate, verify |
| **Canadian Web Hosting** | Vancouver, Toronto, Coquitlam | Unknown | Unknown | Unknown | from CAD $6.95 [S42] | Canadian [S42] | Candidate, verify |
| **FullHost** | Vancouver, Calgary, Toronto, Montreal | Unknown | Unknown | Unknown | from $7 [S43] | Canadian (Victoria) | Candidate, verify |
| **AWS** | Montreal, Calgary | Blocked; per-region form; denials happen [S32][S33] | Via the same form | Yes | High | US | Poor |
| **DigitalOcean** | Toronto | Blocked 25/465/587; no documented unblock [S22] | Yes | Yes | US$48 [S24] | US | **No** |
| **Hyperscaler A** | Montreal, Toronto | Blocked; auto-lifted only if the vendor deems project low-risk | Yes | Yes | High | US | **No** |
| **Hyperscaler B** | Toronto, Quebec City | Blocked except enterprise agreements | Yes | Yes | High | US | **No** |
| **Hetzner** | None [S17] | — | — | — | — | German | **No** |
| **ThinkOn** | Yes | Unknown | Unknown | Unknown | Partner quote [S44] | Canadian | No (enterprise) |

### 1.4 Ranked recommendation

1. **OVHcloud VPS, Beauharnois (VPS-3, or VPS-2 plus block storage).**
   - Cheapest by a wide margin.
   - Port 25 is reportedly open by default and OVH's anti-spam system is self-service.
   - PTR is self-service for v4 and v6.
   - Up to 16 additional IPs allow a later split into free and paid outbound IPs.
   - The parent is not US, which fits the privacy positioning better than the US clouds, but say "Canadian data centre", not "immune to foreign orders" [S15][S16].
   - Main risks are neighbourhood reputation on AS16276 [S11][S12] and OVH's automatic port-25 blocks. A false positive would stop all outbound mail until we unblock it.
   - Mitigations:
     - Screen the assigned IP before go-live (section 2) and request a different one, or buy an additional IP, if it is dirty.
     - Script the unblock API call into an alert, not an automatic unblock.
     - Have a smart-host fallback ready (section 8).
2. **Akamai/Linode Toronto (shared 8 GB).** The unblock process is documented and predictable, Linode checks rDNS as part of it, PTR is self-service and the company has a long history of hosting small mail servers [S25][S26][S27]. The drawbacks are higher cost and US ownership.

Before signing, send the same three written questions (port 25, PTR v4/v6, mail-hosting ToS) to **Canadian Web Hosting** (Vancouver) and **LunaNode** (Toronto). If either confirms all three in writing, it beats #2 for a privacy-positioned, Canadian-owned brand. Because neither publishes those policies, neither can be ranked yet.

---

## 2. IP reputation checks before go-live

### 2.1 Tools

| Tool | What it tells you |
|---|---|
| Spamhaus IP & Domain Reputation Checker, check.spamhaus.org [S47] | SBL, CSS, XBL and PBL status for IPv4, IPv6 and domains. A CSS listing gets a troubleshooting flow (added Dec 2025) [S47]. Spamhaus is the most consequential list. |
| MXToolbox Blacklist Check, mxtoolbox.com/blacklists.aspx [S48] | A sweep of about 80–100 DNSBLs. Also check SMTP banner and PTR. |
| multirbl.valli.org [S49] | Wider DNSBL sweep that includes IPv6 lists and many regional lists. |
| Cisco Talos Reputation Center, talosintelligence.com/reputation_center [S50] | Email reputation (Good/Neutral/Poor) used by Cisco/IronPort gateways. |
| Barracuda Central, barracudacentral.org/lookups [S51] | Barracuda BRBL, which many SMB appliances use. |
| Validity Sender Score, senderscore.org [S52] | 0–100 score. A new IP has "no score", which is fine. |
| AbuseIPDB, abuseipdb.com [S53] | Prior abuse reports such as SSH brute force, a sign that the IP was recently a compromised box. |
| UCEPROTECT (L1/L2/L3) | L3 lists entire ASNs once their SPAMSCORE reaches 50 or more with at least 50 L1 impacts in 7 days. A tenant cannot delist an L3 listing [S54]. Few large receivers use UCEPROTECT L3; note it, but do not panic. |
| Microsoft SNDS (new portal since June 2026) [S55] | Register the IP before sending. It shows Microsoft's view of the IP once traffic flows. |

### 2.2 Checklist for a newly assigned IP and its /24

1. **The IP itself.** It should be absent from Spamhaus SBL, CSS and XBL, and from Barracuda, SpamCop and PSBL. A PBL hit on a server IP can be self-removed with a PTR in place. Talos should show "Neutral" or better. AbuseIPDB should show no reports in the last 90 days.
2. **The /24.** Run the MXToolbox and valli sweeps on several neighbours (.1, .50, .100, .200). Check Spamhaus for SBL listings covering the range. A neighbourhood with many listings is a reason to ask for a different IP or buy an additional IP from a different block. OVH community reports describe entire /24s being listed [S12].
3. **The ASN.** Check UCEPROTECT L3 status (informational) [S54].
4. **History.** Search the IP in web search engines and in their cached spam reports. Run `dig -x` to see any stale PTR.
5. **IPv6.** Check the /64 on Spamhaus and valli. Many receivers prefer IPv4 for new senders. Consider sending to Gmail and Outlook over IPv4 only until the IPv6 reputation is established (Stalwart supports per-destination source IP selection; confirm config).
6. **Receiver handshake.** Before announcing, send test messages to Gmail, Outlook.com and Yahoo and read the SMTP responses for 4xx/5xx codes such as Outlook S3150/S3140 block-list codes [S13].
7. **Repeat checks.** Run the same sweep weekly through warm-up and daily during any spike.

---

## 3. Mailbox-provider feedback programs and sender requirements

### 3.1 Google (Gmail)

- **Requirements for all senders, enforced since 1 Feb 2024** [S30]:
  - SPF or DKIM.
  - Valid forward and reverse DNS, with the PTR host resolving back to the IP.
  - TLS for transmission.
  - Spam rate below 0.3% in Postmaster Tools.
  - RFC 5322-compliant messages.
  - No impersonation of Gmail From: headers.
- **Additional requirements for bulk senders (more than 5,000 messages/day to Gmail)** [S30]:
  - Both SPF and DKIM.
  - DMARC; `p=none` is acceptable.
  - From: domain aligned with SPF or DKIM.
  - One-click unsubscribe for marketing mail.
  - The guideline is to stay below 0.10% spam rate and never reach 0.30% [S30].
- **Enforcement since Nov 2025.** Google posted on 3 Nov 2025 that enforcement was ramping up. Non-compliant traffic now gets temporary (4xx) and permanent (5xx) rejections [S56][S57].
- **Postmaster Tools.** The v2 interface launched in 2024 and adds a Compliance Status dashboard ("Compliant" / "Needs work") [S58]. Google has **postponed** retiring the legacy v1 web UI, with no date given. The v1 API will be retired in favour of the v2 API [S59]. Several vendor posts claimed v1 was removed on 30 Sep 2025. Google's own page contradicts that, so treat v1 as "still alive, going away" [S58][S59].
- **What applies to AnhourMail.** Gmail measures the 5,000/day threshold per sending domain, so the "bulk" rules may never formally apply to person-to-person mail. Comply with all of them anyway: SPF, DKIM, DMARC, alignment, PTR, TLS. Bulk status is permanent once triggered, and the cost of compliance is low. One-click unsubscribe is only relevant to any newsletters AnhourMail itself sends. Register `anhourmail.com` (and later each DKIM `d=` domain we sign with) in Postmaster Tools. With low volume the dashboards may show no data; that is normal.

### 3.2 Microsoft (Outlook.com, Hotmail, Live)

- **High-volume sender requirements.** For domains sending more than 5,000/day to Microsoft consumer domains, SPF, DKIM and DMARC (at least `p=none`, aligned) became mandatory from 5 May 2025. Rejections use `550 5.7.515 Access denied, sending domain ... does not meet the required authentication level` [S60]. Microsoft's April 2025 post said non-compliant mail would first be routed to Junk, with rejection at a later, unannounced date. As of mid-2026, third-party trackers still report the hard-reject date as "to be announced", while others report 5.7.515 bounces in the wild [S60][S61]. Assume rejection is possible.
- **SNDS and JMRP changes in June 2026.** SNDS moved to a new portal at `substrate.office.com/ip-domain-management-snds/SNDS` on 8 June 2026, and old automated-access URLs were deprecated around 22 June 2026 [S55][S62]. JMRP complaint reports are now redacted (no body, recipient hidden), sample downloads are gone, and JMRP feeds not linked to an SNDS account were removed [S62][S63]. Early users reported access-confirmation emails not arriving and buggy FBL registration [S55]. Practitioner sources reported these points; Microsoft has not published a primary announcement, so dates are **partially UNVERIFIED**.
- **Action.** Register the outbound IP(s) in the new SNDS and enrol JMRP from within SNDS. Because complaints arrive redacted, put an opaque per-account token in the `Message-ID` (or a custom header) so complaints can be mapped to the sending user [S55].
- **Delisting.** Use Microsoft's Sender Support / delist form [S13]. Microsoft rate-limits senders without history, so a sudden spike from a new IP reads as spam [S64].

### 3.3 Yahoo (and AOL)

- Yahoo applies the same Feb-2024 regime as Gmail: authentication for all senders, plus DMARC and one-click unsubscribe for bulk senders [S65].
- **Complaint Feedback Loop (CFL).** CFL is keyed to the **DKIM d= domain**, not the IP. Yahoo sends an ARF report for complaints about messages signed with an enrolled DKIM domain. You enrol through Yahoo Sender Hub: create a sender profile, verify the domain, then enrol it in the CFL [S66][S67].
- **Action.** Enrol `anhourmail.com`. If customer domains are signed with their own `d=`, each would need separate enrolment. That is one reason to also add a provider-domain DKIM signature, `d=anhourmail.com` or a dedicated signing domain, on all outbound mail so one CFL enrolment covers everything (see section 4).

### 3.4 What applies to a mailbox host

- Person-to-person mail from many users is spread across thousands of `From:` domains (later, customer domains) but shares **our IPs**. IP reputation is shared across all users.
- Gmail's and Microsoft's 5,000/day thresholds are per sending domain [S30][S60]. `anhourmail.com` itself could cross them once there are a few thousand active users.
- The spam-rate limits (0.1% target, 0.3% ceiling [S30]) are the binding constraint, and one abusive user can push them over.

---

## 4. DKIM

### 4.1 Keys

- **RSA 2048-bit as the primary key.** Stalwart's current docs require at least 2048 bits [S68]. M3AAWG prefers 2048 [S69].
- **Ed25519 (RFC 8463) dual signing.** Stalwart signs with both RSA and Ed25519 by default [S68][S70]. **Gmail does not verify Ed25519**: it reports `dkim=fail` for the Ed25519 signature in aggregate reports while the RSA signature on the same message passes. DMARC still passes. Stalwart support confirmed "Gmail does not support ed25519" (June 2026) [S71]. Dual signing does no harm, but it adds noise to DMARC reports. Recommendation: keep RSA-2048 as mandatory. Treat Ed25519 as optional: on if you value forward compatibility, off if DMARC report noise is a problem.

### 4.2 Customer domains by CNAME delegation

The customer publishes CNAMEs pointing into a zone the provider controls. The provider can then rotate keys by changing the TXT record behind the CNAME, and the customer never touches DNS again [S72].

| Provider | Customer publishes |
|---|---|
| Provider K (established JMAP provider) | Three `<prefix>1/2/3._domainkey` CNAMEs to per-customer names under the provider's DKIM zone (all three required) |
| Provider L (low-cost) | Three `<prefix>1/2/3._domainkey` CNAMEs to `key1/2/3` under the provider's DKIM root zone. It signs "with one of three different keys, which we regularly rotate". It also delegates `_dmarc` by CNAME to its own DMARC zone. |
| Provider M (budget host) | Uses the same CNAME pattern (key1–key3 under its own zone). Its DNS guide URL returned 404 on 2026-10-21, so the exact target names are **UNVERIFIED**. |

Providers anonymised (rule 57); the named version is kept locally in `docs/internal/private/competitors/deliverability.named-2026-10-22.md` (gitignored).

**Design for AnhourMail (custom domains, post-v1)**
- **Customer records.** `ah1._domainkey.customer.com CNAME ah1.customer-com.dkim.anhourmail.net.`, plus the same for `ah2` and `ah3`.
- **Separate DKIM zone.** Host the provider side in a dedicated zone (e.g. `dkim.anhourmail.net`), with DNSSEC on and a short TTL (300–3600 s).
- **Three selectors.** At any time, one selector signs, one is pre-published as the next key, and one is retiring. This is the pattern established providers use (table above).
- **Stalwart caveat.** Stalwart's automatic rotation generates **date-based selector names** (`v1-ed25519-20260101`) and requires automatic DNS management of the signing domain [S70]. That conflicts with fixed customer-facing CNAME selectors. Either:
  - (a) run Stalwart's DNS automation against the `dkim.anhourmail.net` zone and map fixed selectors in our own tooling, or
  - (b) manage rotation of the three fixed selectors with a small script calling Stalwart's API.

  Prototype this before offering custom domains. **UNVERIFIED** that Stalwart supports the fixed-selector-rotation model natively.

### 4.3 Rotation cadence and steps

- **Cadence.** M3AAWG's floor is at least every six months [S69]. Stalwart's default is 90 days [S70]. Use 90 days.
- **Steps (per selector):**
  1. Generate the new key and publish the TXT record on the next selector, or the provider-side name behind its CNAME.
  2. Wait for DNS propagation (at least 2× TTL). Stalwart gates the cutover on confirmed propagation [S70].
  3. Switch signing to the new selector.
  4. Keep the old public key published for at least 7 days for in-flight and retried mail. Stalwart's `retireAfter` defaults to 7 days, and M3AAWG material cites 7–30 days [S69][S70].
  5. Remove or empty the old public key. Delete the private key material (Stalwart's default is 30 days) [S70].
  6. Check DMARC aggregate reports for `dkim=fail` spikes on the new selector.

---

## 5. Transport security and other authentication

### 5.1 MTA-STS (RFC 8461) [S75]

- **TXT record.** `_mta-sts.anhourmail.com TXT "v=STSv1; id=20261021T000000"`. Change the `id` on every policy edit.
- **Policy file.** Served over HTTPS with a valid public certificate at `https://mta-sts.anhourmail.com/.well-known/mta-sts.txt`:
  ```
  version: STSv1
  mode: testing
  mx: mx1.anhourmail.com
  max_age: 86400
  ```
- **Rollout.** Start in `mode: testing` with a short `max_age` (1 day). After 2–4 weeks of clean TLS-RPT reports, switch to `mode: enforce` and raise `max_age` to 1–2 weeks (604800–1209600 s). RFC 8461 allows up to 31557600 s; a long max_age makes MX changes painful.
- **Hosting.** The policy host can be served by the app's reverse proxy on the same VPS.
- **Customer domains.** Customers can CNAME `mta-sts.customer.com` and `_mta-sts.customer.com` to us, but then we must serve TLS for `mta-sts.customer.com`, which means automated ACME per customer. Defer this.

### 5.2 TLS-RPT (RFC 8460) [S76]

- `_smtp._tls.anhourmail.com TXT "v=TLSRPTv1; rua=mailto:tlsrpt@anhourmail.com"`.
- Reports arrive daily as JSON. Use a separate mailbox or a parsing service.

### 5.3 DANE / TLSA (RFC 7672) [S77]

- **Requires DNSSEC** on `anhourmail.com` and on the MX host's zone.
- **Record.** Publish `_25._tcp.mx1.anhourmail.com TLSA 3 1 1 <sha256 of SPKI>`. Pin the SPKI, not the certificate, so Let's Encrypt renewals that **reuse the key** do not break it. If the key rotates, publish the new TLSA record at least 2× TTL before the certificate changes.
- **Who supports it.** Exchange Online has supported inbound DANE since GA on 22 Oct 2024 [S78]. Outbound DANE validation by Microsoft was announced for 2025 [S78]; whether it took effect is **UNVERIFIED**. No source was found on Gmail DANE validation; Gmail relies on MTA-STS.
- **Recommendation.** Enable it if the DNS host supports DNSSEC well (e.g. deSEC, Cloudflare, or a registrar with DNSSEC). Otherwise defer to v1.1. MTA-STS covers Gmail regardless.

### 5.4 BIMI: skip for v1

- Requires DMARC at `p=quarantine` or `p=reject` with pct=100 [S79].
- Gmail requires a VMC (trademark required) or CMC (12 months of logo use) [S79]. Cost is roughly US$650–1,700 per year plus trademark costs, based on vendor estimates [S79].
- Only shows our logo on mail from `@anhourmail.com` (system mail), not on users' mail. Low value for v1.

### 5.5 ARC (RFC 8617) [S80]

- Matters if AnhourMail **forwards** mail (user forwarding rules, aliases) or modifies messages (footers, subject tagging). ARC lets downstream receivers trust the upstream authentication results.
- Gmail's forwarding guidance does not mention ARC. It recommends rewriting the envelope sender (SRS), not breaking DKIM, and adding `X-Forwarded-To` headers [S81].
- Stalwart supports ARC sealing. Enable ARC sealing **and** SRS for forwarded mail at v1, since forwarding rules are a standard mailbox feature.

---

## 6. Warm-up plan for a new mailbox-provider IP and domain

This is not a bulk sender. Mail volume is organic and grows with users, so the warm-up is mostly about controlling **who** gets an account and **how much** they can send, not about scheduling campaigns.

- **Gmail's guidance.** Ramping too fast causes delivery issues. After a deferral, pause 15 minutes, send a test message, and hold volume below the deferral level for 24 hours. Then grow 25–100% per day. Send at a steady rate rather than in bursts; consistency "is particularly important for new domains" [S82].
- **Microsoft.** Microsoft rate-limits new senders, so build Outlook.com volume gradually [S64].

### 6.1 Phases

- **Week −4 to −2: infrastructure and dogfooding.**
  - DNS, PTR, SPF, DKIM, DMARC (`p=none`), MTA-STS (`testing`) and TLS-RPT all in place.
  - Staff (2–5 people) use AnhourMail as their **primary** mailbox and write real, replied-to mail to colleagues and contacts at the big free mailbox providers and a privacy-focused provider.
  - Ask recipients to mark "Not spam" and add the address to contacts if the mail lands in spam.
- **Seed testing in the same window.**
  - mail-tester.com (aim for 10/10).
  - GlockApps or a similar seed-list inbox-placement test, run weekly.
  - Gmail "Show original" for SPF, DKIM and DMARC = PASS and TLS.
- **Monitoring from day 1.**
  - Google Postmaster Tools (v2 Compliance plus spam rate).
  - SNDS.
  - DMARC aggregate reports.
  - TLS-RPT.
  - Stalwart queue depth and deferral codes.

### 6.2 Metrics and thresholds

| Metric | Target | Action threshold |
|---|---|---|
| Gmail user-reported spam rate (Postmaster) | < 0.1% [S30] | ≥ 0.1% investigate; ≥ 0.3% freeze signups and new-account sending [S30] |
| Microsoft complaint rate (JMRP) / SNDS colour | Green | Yellow/Red: throttle, find the offending accounts |
| Hard bounce rate (5xx unknown user) per day | < 2% | > 5% from any account: suspend sending for that account (list-washing or a compromised account) |
| Deferrals (4xx) to any provider | < 1% | Sustained rise: hold volume for 24 h per Google's guidance [S82] |
| DMARC pass rate on own domains | > 99% | Any drop: check DKIM rotation/DNS |
| Blocklist status (Spamhaus/Barracuda/Talos) | Clean | Any listing: stop outbound for the abusing account, delist |

### 6.3 Warm-up schedule

See the recommendations section for the schedule table.

---

## 7. Free-tier abuse: lessons from other providers

Providers are anonymised in this public doc (CLAUDE.md rule 57); the named version is kept locally in `docs/internal/private/competitors/deliverability.named-2026-10-22.md` (gitignored), with every source.

**Provider A (community-run, free)**
- In 2018 it closed registrations, estimating that "about 80% of our user base are scammers, spammers and abusers". It cleaned up accounts and redesigned signup.
- Lesson: open, anonymous, free signup overwhelms a small team within a year.

**Provider B (activist collective, free)**
- Email is invite-only because "spammers and scammers" abused the previous system and caused its services to be blocked by other providers.
- Each invite ties the new account to the inviter for a period. New accounts cannot create invites. Accounts linked to a ToS violator can be suspended together.
- Lesson: invites plus inviter accountability work, but they severely limit growth.

**Provider C (privacy-focused, free tier)**
- Human verification uses CAPTCHA, email or SMS. The method is chosen by risk signals, and multiple account creation or Tor triggers harder methods.
- Phone numbers and emails are stored only as hashes. The stated reason is that spam via its service would get its IPs blocked by other providers.
- Free accounts are capped at 50 emails/hour and 150/day. Each recipient counts separately.
- Automated anti-abuse disables new accounts soon after creation, and the provider acknowledges false positives.

**Provider D (privacy-focused, free tier)**
- New free addresses can be held about 48 hours pending approval "to prevent abuse by spammers and still offer an anonymous email registration".
- Users report waits of up to a week.

**Provider E (paid, with a trial)**
- The 30-day trial can send only 10 emails/day, only to other users of the same provider, with external sending blocked. The trial also limits inbound mail from social/payment/verification senders and caps storage at 100 MB.
- The stated reason is that trials were misused for spam, fraudulent third-party signups and illegal file sharing. A payment lifts all limits.
- Ongoing abuse scoring uses account age and recent volume, with criteria not disclosed.
- Lesson: **payment as identity** is the cleanest gate.

**Provider F (business suite, free plan)**
- The free plan was quietly cut to webmail-only, with no IMAP, POP or SMTP. Users complained of no notice.
- No official reason was given; abuse is a likely but **UNVERIFIED** motive.

**Provider G (anonymous, free)**
- Widely classified as a disposable or high-risk domain and blocked by signup-verification services since at least 2020. Registration went offline in Nov 2024 amid what the operator described as government pressure.
- Lesson: once a domain gets a reputation for anonymous abuse, recipients block the **domain**, not just IPs, and that is permanent.

**Provider H (large free webmail)**
- Large-scale spam from **compromised** accounts has been reported, with attackers using botnets to bypass per-IP login rate limits. New accounts are reportedly blocked when several are created (anecdotal).
- Lesson: hijacked legitimate accounts are as big a threat as fake signups. Account-takeover defences (2FA, impossible-travel login alerts, outbound anomaly detection) are part of deliverability.

**Providers I and J (paid-only, low cost)**
- Neither offers a perpetual free tier. One requires prepayment; the other limits use to "non-automated personal or business correspondence" and bans bulk, newsletters, transactional mail and automation.
- No public reports of major spam waves were found for either. Absence of evidence is not proof.

### 7.1 Controls that worked

| Control | Evidence |
|---|---|
| Payment as identity (even $1) | Provider E lifts all limits on payment; Providers I and J are paid-only |
| New-account outbound restriction (internal-only or very low caps) | Provider E trial: 10/day, internal only |
| Hard per-account rate caps | Provider C free: 50/hr, 150/day, each recipient counted |
| Risk-based verification (CAPTCHA → email → SMS, hashed storage) | Provider C |
| Manual or delayed approval of new accounts | Provider D: 48 h hold |
| Invite codes with inviter accountability | Provider B |
| Behavioural scoring (account age, volume history) | Provider E |
| Closing signups during an abuse wave, then purging | Provider A |

**Implication for AnhourMail.** A free tier with open, anonymous signup at launch, on a **single shared IP**, is the highest-risk configuration. Every one of the providers above that offered anonymous free signup eventually had to add gates.

---

## 8. Outbound IP separation, smart-host fallback, second MX

### 8.1 Separate outbound IPs for free and paid

- **Why.** IP reputation is shared. Abuse from free accounts would poison delivery for paying users. Provider C's verification rationale (§7) shows this risk directly.
- **When.**
  - **Before** any free tier is opened to the public, or
  - when free-account volume exceeds about 10–20% of outbound, or
  - at the first blocklist incident traced to a free account.
- **How (OVH).** Add 1–2 Additional IPs to the VPS (up to 16 are allowed [S2]). Each needs its own PTR, its own SNDS registration and its own warm-up. Use Stalwart's outbound routing or strategies to choose the source IP by sender account class. Also isolate system/transactional mail (signup, password reset) on its own IP or relay, so that a reputation incident cannot block password resets.
- **Caveat.** A brand-new free-tier IP with only free-tier traffic will warm up slowly and may have worse delivery. That is intended: it limits damage. Keep both IPs within SPF (`ip4:` entries or an `include:` of a provider SPF record).

### 8.2 Smart-host / relay as fallback

- **Purpose.** If OVH auto-blocks port 25 [S5] or a major receiver blocks our IP, we need a pre-configured fallback relay on port 587, enabled by a config flag rather than built during an outage.
- **Canadian-resident options (vendor claims, UNVERIFIED independently):**
  - Cyberimpact SMTP ("your data never leaves Canada") [S102].
  - Maileroo (data residency in Toronto/Vancouver) [S103].
  - SMTP.com is headquartered in Ottawa, but its data location is unknown [S104].
  - SMTP2GO has no Canadian region (US/EU/AU only) [S105].
- **ToS check.** Many transactional relays forbid relaying **third-party users'** person-to-person mail, or require approval. Get written confirmation that mailbox-provider relaying is allowed before relying on one.
- **Privacy and SPF.** Using a relay routes user mail through a third party, which needs a privacy-policy mention. The relay's include must be in SPF only while it is in use.

### 8.3 Second MX

- RFC 5321 requires senders to keep retrying for typically at least 4–5 days [S106]. A short outage of a single MX loses no mail.
- Backup MX hosts are a classic spam vector: they often lack recipient validation and spam filtering, so spammers target them.
- **Recommendation.** Use **no secondary MX in v1.** Rely on sender retries, solid backups and fast restore. Add a second MX only when there is a second Stalwart node (v2 clustering) with the same recipient validation and filtering.

---

## Recommendations for AnhourMail

### Provider pick

1. **Primary: OVHcloud VPS, Beauharnois.** Use VPS-3 (6 vCore / 12 GB / 100 GB NVMe, about $16.83/mo, 12-month term) [S2], or VPS-2 plus additional block storage. Buy **one Additional IP** at order time so there is a spare. Test port 25 on day one, before building anything.
2. **Backup / alternative: Akamai/Linode Toronto.** File the port-25 ticket on account creation so it is pre-approved if OVH falls through [S25][S26].
3. **In parallel:** email Canadian Web Hosting (Vancouver) and LunaNode (Toronto) to ask for written answers on port 25, PTR v4/v6, IPv6 and whether hosting a consumer mail service is allowed. If either confirms all of them, reconsider them for the "Canadian-owned" story.

### Pre-launch checklist

- [ ] VPS provisioned. `nc -vz gmail-smtp-in.l.google.com 25` succeeds from the box (v4 and v6).
- [ ] IP and /24 screened (section 2). Swap the IP if it is listed on Spamhaus SBL/CSS/XBL, Barracuda or Talos "Poor".
- [ ] Hostname `mx1.anhourmail.com` has A and AAAA records. PTR v4 and v6 set to `mx1.anhourmail.com` and forward-confirmed. The SMTP banner/EHLO name matches.
- [ ] TLS certificates for `mx1`, `mail` and `mta-sts` (ACME). Pin the SPKI in TLSA if DANE is used.
- [ ] SPF, DKIM (RSA-2048; Ed25519 optional), DMARC `p=none` with `rua` reports.
- [ ] MTA-STS `testing` with TLS-RPT.
- [ ] DNSSEC on the zone (needed for DANE).
- [ ] Google Postmaster Tools domain verified. SNDS IP registered and JMRP enrolled. Yahoo Sender Hub CFL enrolled for `anhourmail.com`.
- [ ] Postmaster@ and abuse@ mailboxes exist and are monitored (RFC 2142).
- [ ] Opaque per-account token in `Message-ID` so redacted JMRP reports can be mapped to the sender [S55].
- [ ] Outbound limits configured in Stalwart:
  - New accounts (< 7 days): 20 recipients/hour, 100/day.
  - Established accounts: 100/hour, 500/day.
  - A per-message recipient cap.
  - Auto-suspend on hard-bounce spikes.
- [ ] Outbound spam filtering on submitted mail (Stalwart's spam filter on outbound).
- [ ] Fallback relay account created and tested, but disabled.
- [ ] OVH anti-spam block → alert (email/SMS to the operator via an API poll of `/ip/{ip}/spam`) [S5].
- [ ] ARC sealing and SRS enabled for forwarding.
- [ ] mail-tester 10/10. Seed test placement in inbox at Gmail, Outlook and Yahoo.
- [ ] Signup gating decided (see the free-tier warning below).
- [ ] Privacy policy states the hosting location (Beauharnois, QC), the provider and any relay.

### Warm-up schedule

Volumes are total outbound messages/day from the main IP. Tighten them if any threshold in section 6.2 is hit.

| Week | Who has accounts | Outbound/day (cap) | Per-account cap (new / established) | Gates and checks |
|---|---|---|---|---|
| −4 to −3 | Staff (2–5) | ≤ 50 | — | Infrastructure live; seed tests; Postmaster/SNDS registered |
| −2 to −1 | Staff + friends & family (≤ 25) | ≤ 150 | 50 / 100 | DMARC reports clean; mail-tester 10/10; Gmail "Show original" all PASS |
| 1 | Closed beta by invite (≤ 100) | ≤ 400 | 50 / 200 | Daily blocklist sweep; review every bounce/deferral |
| 2 | ≤ 250 users | ≤ 1,000 | 50 / 300 | Spam rate < 0.1%; switch MTA-STS to `enforce` if TLS-RPT is clean |
| 3–4 | ≤ 500 users, paid launch | ≤ 2,500 | 100 / 500 | DMARC `p=quarantine; pct=25` → 100 |
| 5–8 | Paid signups open | ≤ 5,000, growing ≤ 50%/week | 100 / 500 | DMARC `p=reject`; weekly seed tests |
| 9+ | — | Organic | Per-plan limits | Add the free-tier IP **only** with gates (below) |

### DNS record set for anhourmail.com

IPs are placeholders. Replace `203.0.113.10` / `2001:db8::10` with real values.

```
; --- Host records
mx1.anhourmail.com.            A      203.0.113.10
mx1.anhourmail.com.            AAAA   2001:db8::10
mail.anhourmail.com.           CNAME  mx1.anhourmail.com.     ; IMAP/SMTP/JMAP client hostname
mta-sts.anhourmail.com.        A      203.0.113.10
mta-sts.anhourmail.com.        AAAA   2001:db8::10
; PTR (set at the hosting provider): 203.0.113.10 -> mx1.anhourmail.com. ; 2001:db8::10 -> mx1.anhourmail.com.

; --- Mail routing
anhourmail.com.                MX     10 mx1.anhourmail.com.

; --- SPF (hard fail; add relay include only while relay is active)
anhourmail.com.                TXT    "v=spf1 ip4:203.0.113.10 ip6:2001:db8::10 -all"
mx1.anhourmail.com.            TXT    "v=spf1 a -all"          ; HELO identity

; --- DKIM (RSA-2048 primary; selectors rotate every 90 days)
ah1._domainkey.anhourmail.com. TXT    "v=DKIM1; k=rsa; p=<2048-bit public key>"
ah2._domainkey.anhourmail.com. TXT    "v=DKIM1; k=rsa; p=<next key, pre-published>"
; optional: ed1._domainkey.anhourmail.com. TXT "v=DKIM1; k=ed25519; p=<key>"

; --- DMARC (start p=none, move to quarantine then reject per warm-up table)
_dmarc.anhourmail.com.         TXT    "v=DMARC1; p=none; rua=mailto:dmarc@anhourmail.com; adkim=s; aspf=s; fo=1"

; --- MTA-STS + TLS-RPT
_mta-sts.anhourmail.com.       TXT    "v=STSv1; id=20261021T000000"
_smtp._tls.anhourmail.com.     TXT    "v=TLSRPTv1; rua=mailto:tlsrpt@anhourmail.com"

; --- DANE (only with DNSSEC signed zone)
_25._tcp.mx1.anhourmail.com.   TLSA   3 1 1 <sha256 of mx1 SPKI>

; --- Client autodiscovery (RFC 6186 / 8314)
_submissions._tcp.anhourmail.com. SRV 0 1 465 mail.anhourmail.com.
_submission._tcp.anhourmail.com.  SRV 0 0 0   .
_imaps._tcp.anhourmail.com.       SRV 0 1 993 mail.anhourmail.com.
_imap._tcp.anhourmail.com.        SRV 0 0 0   .
_jmap._tcp.anhourmail.com.        SRV 0 1 443 mail.anhourmail.com.
autoconfig.anhourmail.com.        CNAME mail.anhourmail.com.
autodiscover.anhourmail.com.      CNAME mail.anhourmail.com.

; --- Certificate authority restriction
anhourmail.com.                CAA    0 issue "letsencrypt.org"

; --- Verification records (values from each console)
anhourmail.com.                TXT    "google-site-verification=<token>"   ; Postmaster Tools
```

Notes:
- `adkim=s; aspf=s` (strict alignment) suits a domain where only AnhourMail sends. Relax it to `r` if subdomains will send through other services.
- Put the MTA-STS policy at `https://mta-sts.anhourmail.com/.well-known/mta-sts.txt` (section 5.1).
- For later customer domains, publish CNAMEs to `ahN.<customer>.dkim.anhourmail.net` (section 4.2).

### Things that contradict or put the plan at risk

1. **A free tier at launch is high-risk on a single IP.** Every comparable provider that offered anonymous free signup later added gates (§7): signup closure after an 80%-abuser estimate, invites, verification and caps, approval holds, paid-only external sending. Recommendation:
   - Launch **paid-only**, or with a **free tier that cannot send externally until verified** (the Provider E model, §7), on a **separate outbound IP**.
   - Gate signups with invite or waitlist plus risk-based phone verification.
   - Count each recipient against hard per-account caps.
2. **Port 25 is blocked by default at most big clouds in Canada.** DigitalOcean and the two big US hyperscalers (outside enterprise agreements) are effectively unusable. AWS and Vultr are discretionary. Linode is a predictable ticket. OVH is reportedly open by default but auto-blocks on detected spam. A reasonable Canadian option exists (OVH Beauharnois), so the plan holds. One conflicting third-party claim [S9] means port 25 must be tested before committing.
3. **"Canadian data centre" does not equal "no foreign access".** OVH (French parent with a US subsidiary) has been ordered by a Canadian court to produce EU-stored data [S16], and it acknowledges CLOUD Act reach [S15]. All other large candidates are US-owned. Marketing should claim "hosted in Canada", not "immune to foreign legal process". Only ThinkOn-class providers claim no foreign exposure [S44], and they do not fit v1.
4. **Shared IP on one VPS.** App traffic and mail share the box. A compromise of the web app is also a compromise of the mail server's reputation. Keep the mail IP dedicated to mail. If the app serves public web traffic, consider putting it on a separate Additional IP.

### Unverified items to confirm with vendors

- OVH VPS port 25 default state, Canada region [S5][S7][S9].
- LunaNode port 25 policy, rDNS self-service and Canadian ownership [S39][S40].
- Canadian Web Hosting and FullHost: port 25, PTR, IPv6, mail-hosting ToS [S42][S43].
- Linode Toronto price; Vultr 4/8 price [S21][S29].
- Microsoft hard-reject date for 5.7.515 [S60][S61]; exact SNDS/JMRP change dates (practitioner sources only) [S62][S63].
- Microsoft outbound DANE enforcement status [S78]; Gmail DANE support (no source found).
- Provider M's exact DKIM CNAME targets (guide URL returned 404).
- Whether Stalwart supports fixed-selector rotation behind customer CNAMEs [S70].
- Data-residency claims of Cyberimpact and Maileroo [S102][S103].

---

## Sources

- [S1] OVHcloud VPS (en-ca): https://www.ovhcloud.com/en-ca/vps/
- [S2] OVHcloud VPS Canada (fr-ca): https://www.ovhcloud.com/fr-ca/vps/vps-canada/
- [S3] OVHcloud Toronto Data Center: https://www.ovhcloud.com/en-ca/lp/new-toronto-datacenter/
- [S4] Trade & Industry Development, OVHcloud opens Toronto-area DC: https://www.tradeandindustrydev.com/region/ontario/news/cn-ovhcloud-opens-new-data-center-and-invests-145-32902 ; DCD: https://www.datacenterdynamics.com/en/news/ovhcloud-takes-space-in-ascent-data-center-in-toronto-canada
- [S5] OVHcloud AntiSpam best practices and unblocking an IP: https://docs.ovhcloud.com/en/guides/bare-metal-cloud/dedicated-servers/antispam-best-practices
- [S6] OVHcloud Community, "Déblocage port 25": https://community.ovhcloud.com/t/deblocage-port-25-comment-faire/17027
- [S7] forwardemail, awesome-mail-server-providers: https://github.com/forwardemail/awesome-mail-server-providers
- [S8] CaptainDNS, Port 25 blocked: diagnosis by provider (Feb 2026): https://www.captaindns.com/en/blog/port-25-blocked-diagnosis-solutions
- [S9] learnwithhasan, OVHcloud VPS review: https://learnwithhasan.com/vps-providers/ovh-vps/
- [S10] OVHcloud, Configure reverse DNS (VPS): https://docs.ovhcloud.com/en/guides/bare-metal-cloud/virtual-private-servers/configuring-reverse-dns
- [S11] NERD IP lookups (OVH BHS ranges): https://nerd.liberouter.org/nerd/ip/54.39.219.112 ; https://nerd.liberouter.org/nerd/ip/144.217.82.25
- [S12] OVHcloud Community, "IP blocks blacklisted and unresponsive support": https://community.ovhcloud.com/t/ip-blocks-blacklisted-and-unresponsive-support/35486
- [S13] Register forums (Mar 2026), Outlook.com rejections: https://forums.theregister.com/forum/all/2026/03/04/users_fume_at_outlookcom_email/ ; TransIP KB on Microsoft blocking: https://www.transip.eu/knowledgebase/232-microsoft-blocking-mails-there-something ; Virtualmin forum S3150: https://forum.virtualmin.com/t/outlook-blocking-emails-from-my-vps-mail-server-550-5-7-1-error-ip-reputation-deliverability-issue/135792
- [S14] OVHcloud US, Delisting blocklisted IPs: https://support.us.ovhcloud.com/hc/en-us/articles/32832332990227-Delisting-blocklisted-IP-addresses
- [S15] OVHcloud US, CLOUD Act FAQ: https://us.ovhcloud.com/resources/faqs/cloud-act
- [S16] The Register forums, Canadian data order and OVH (Nov 2025): https://forums.theregister.com/forum/all/2025/11/27/canada_court_ovh/
- [S17] Hetzner Cloud locations: https://docs.hetzner.com/cloud/general/locations/
- [S18] Vultr Docs, Why is SMTP blocked (updated 15 Apr 2026): https://docs.vultr.com/support/products/compute/why-is-smtp-blocked
- [S19] Mail-in-a-Box forum / community reports on Vultr unblocks: https://discourse.mailinabox.email/t/smtp-system-status-check/2588
- [S20] Vultr Docs, Configure rDNS / IPv6: https://docs.vultr.com/products/network/dns/management/configure-rdns ; https://docs.vultr.com/how-to-create-reverse-dns-or-ptr-records-in-the-vultr-control-panel
- [S21] whtop listing, Vultr Regular 4vCPU/8GB: https://www.whtop.com/amp/plans/vultr.com/137599 ; vpsbenchmarks: https://www.vpsbenchmarks.com/hosters/vultr/plans/111
- [S22] DigitalOcean Docs, Why is SMTP blocked (verified 13 Jul 2026): https://docs.digitalocean.com/support/why-is-smtp-blocked/
- [S23] DigitalOcean Community, port 25 unblocking threads: https://www.digitalocean.com/community/questions/25-port-block-for-all-news-users ; https://www.digitalocean.com/community/questions/is-port-25-blocked-by-digital-ocean-preventing-postfix-sending-emails
- [S24] DigitalOcean Droplet pricing: https://www.digitalocean.com/pricing/droplets
- [S25] Linode blog, A new policy to help fight spam: https://www.linode.com/blog/linode/a-new-policy-to-help-fight-spam/
- [S26] Linode Community, ports 25/465/587 blocked by default: https://www.linode.com/community/questions/19082/i-just-created-my-first-linode-and-i-cant-send-emails-why-mailing-ports-25-465-a
- [S27] Mail-in-a-Box forum, "Should we remove Linode as a suggestion?": https://discourse.mailinabox.email/t/should-we-remove-linode-as-a-suggestion/7379
- [S28] Linode Community, restricted SMTP port: https://www.linode.com/community/questions/21153/restricted-smtp-port-how-to-resolve
- [S29] Akamai Cloud pricing: https://www.akamai.com/cloud/pricing
- [S30] Google, Email sender guidelines: https://support.google.com/a/answer/81126
- [S31] AWS News Blog, Canada West (Calgary) Region: https://aws.amazon.com/blogs/aws/the-aws-canada-west-calgary-region-is-now-available
- [S32] AWS re:Post, Remove port 25 throttle on EC2: https://repost.aws/knowledge-center/ec2-port-25-throttle ; Lightsail rDNS doc: https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-configuring-reverse-dns.html
- [S33] AWS re:Post, SMTP via NAT Gateway still blocked: https://www.repost.aws/questions/QUIQDkVrDaQZuuwpgPsaRF8Q/smtp-egress-ports-25-465-587-through-nat-gateway-silently-dropped-even-after-ec2-email-sending-limits-were-removed
- Hyperscaler, provider DKIM and §7 provider sources: in the local named copy in `docs/internal/private/competitors/` (gitignored).
- [S38] LunaNode Locations: https://www.lunanode.com/features/locations
- [S39] Mail-in-a-Box forum, "SMTP restricted by Digital Ocean" (LunaNode remarks): https://discourse.mailinabox.email/t/smtp-restricted-by-digital-ocean/9822
- [S40] LunaNode Wiki FAQ: https://wiki.lunanode.com/index.php/Frequently_asked_questions
- [S41] LunaNode Pricing: https://www.lunanode.com/pricing
- [S42] Canadian Web Hosting, llms.txt (company facts): https://canadianwebhosting.com/llms.txt
- [S43] FullHost: https://www.fullhost.com/?p=2298
- [S44] ThinkOn sell sheet (2026): https://thinkon.com/wp-content/uploads/2026/02/sell-sheet_critical-compute-services_en_us_003.pdf ; https://thinkon.com/?p=9045
- [S45] Hostinger, Where are servers located: https://www.hostinger.com/support/1583267-where-are-hostinger-servers-located/
- [S46] Datacentermap, Whitelabel IT Solutions: https://www.datacentermap.com/c/whitelabelitsolutions/
- [S47] Spamhaus, IP and Domain Reputation Checker: https://www.spamhaus.org/resource-hub/delisting/good-bye-blocklist-removal-center-hello-ip-and-domain-reputation-checker/ ; https://check.spamhaus.org
- [S48] MXToolbox Blacklist Check: https://mxtoolbox.com/blacklists.aspx
- [S49] multirbl.valli.org: https://multirbl.valli.org/
- [S50] Cisco Talos Reputation Center: https://talosintelligence.com/reputation_center
- [S51] Barracuda Central lookups: https://www.barracudacentral.org/lookups
- [S52] Validity Sender Score: https://senderscore.org/
- [S53] AbuseIPDB: https://www.abuseipdb.com/
- [S54] Suped, UCEPROTECT Level 3: https://www.suped.com/learn/blocklists/uceprotect-dnsbl-level-3 ; MailReach: https://www.mailreach.co/blog/uceprotectl3
- [S55] Spam Resource, "SNDS and JMRP in transition" (19 Jun 2026): https://www.spamresource.com/2026/06/snds-and-jmrp-in-transition.html
- [S56] Spam Resource, Google warns: enforcement ramping up (Nov 2025): https://www.spamresource.com/2025/11/google-warns-sender-requirements.html
- [S57] Red Sift, Gmail's enforcement ramps up: https://redsift.com/blog/gmails-enforcement-ramps-up-what-bulk-senders-need-to-know
- [S58] Blueshift, Google Postmaster Tools v2: https://blueshift.com/blog/google-postmaster-tools-v2/
- [S59] Google, Deprecation of the old Postmaster Tools interface: https://support.google.com/mail/answer/16594218
- [S60] Microsoft Tech Community, Outlook's new requirements for high-volume senders: https://techcommunity.microsoft.com/blog/outlook/strengthening-email-ecosystem-outlook%E2%80%99s-new-requirements-for-high%E2%80%90volume-senders/4399730 ; Mailgun summary: https://www.mailgun.com/blog/deliverability/microsoft-sender-requirements/
- [S61] Egressif, Microsoft sender requirements tracker: https://egressif.io/resources/sender-requirements/microsoft ; Palisade: https://www.palisade.email/email-deliverability/why-do-emails-go-to-junk-in-hotmail-outlook
- [S62] Postmastery, The first big SNDS update in years: https://www.postmastery.com/the-first-big-snds-update-in-years-what-changed-and-why-it-matters/ ; Suped: https://www.suped.com/blog/microsoft-snds-2026-changes-what-senders-need-to-know-before-june-8
- [S63] Litmus, What is Microsoft SNDS: https://www.litmus.com/blog/what-is-microsoft-snds-why-your-deliverability-strategy-depends-on-it
- [S64] Palisade, Why is Outlook blocking my emails: https://www.palisade.email/email-deliverability/why-is-outlook-blocking-my-emails
- [S65] Yahoo Sender Hub, Best practices / sender requirements: https://senders.yahooinc.com/best-practices/
- [S66] Yahoo Sender Hub, Complaint Feedback Loop: https://senders.yahooinc.com/complaint-feedback-loop
- [S67] Spam Resource, What is the Yahoo CFL: https://www.spamresource.com/2022/03/what-is-yahoo-complaint-feedback-loop.html ; Suped: https://www.suped.com/learn/email-deliverability/where-can-i-find-yahoo-postmaster-domain-reputation-data-and-feedback-loop-signup
- [S68] Stalwart docs, DKIM signing: https://stalw.art/docs/mta/authentication/dkim/sign
- [S69] M3AAWG, DKIM Key Rotation BCP: https://m3aawg.org/DKIMKeyRotation ; Valimail summary: https://support.valimail.com/en/articles/15292756-managing-dkim-configurations-for-popular-email-sending-services
- [S70] Stalwart docs, DKIM key rotation: https://stalw.art/docs/domains/dkim-rotation/
- [S71] Stalwart support forum, Ed25519 fails at Gmail (Jun 2026): https://support.stalw.art/t/ed25519-dkim-signatures-fail-verification-at-gmail-while-rsa-signatures-on-the-same-message-pass/562
- [S72] Palisade, What is a DKIM CNAME record: https://www.palisade.email/learning/dkim-cname.md
- [S75] RFC 8461, SMTP MTA Strict Transport Security: https://www.rfc-editor.org/rfc/rfc8461
- [S76] RFC 8460, SMTP TLS Reporting: https://www.rfc-editor.org/rfc/rfc8460
- [S77] RFC 7672, SMTP Security via Opportunistic DANE TLS: https://www.rfc-editor.org/rfc/rfc7672
- [S78] Microsoft Message Center MC711018, Inbound SMTP DANE GA: https://mc.merill.net/message/MC711018 ; Petri: https://petri.com/?p=748168
- [S79] BIMI cost/requirements: https://guptadeepak.com/guides/gmail-blue-checkmark-bimi/ ; https://www.encryptionconsulting.com/implementing-bimi-with-vmc-and-cmc/
- [S80] RFC 8617, Authenticated Received Chain: https://www.rfc-editor.org/rfc/rfc8617
- [S81] Google, Best practices for forwarding email to Gmail: https://support.google.com/mail/answer/175365
- [S82] Google, Top 10 Gmail sender issues: https://support.google.com/mail/answer/15256272
- [S102] Cyberimpact SMTP: https://www.cyberimpact.com/en/smtp/
- [S103] Maileroo, Enterprise SMTP hosting in Canada: https://maileroo.com/enterprise-smtp-hosting/canada
- [S104] Wikipedia, SMTP, Inc.: https://en.wikipedia.org/wiki/SMTP,_Inc.
- [S105] SMTP2GO, SMTP relay hostnames: https://developers.smtp2go.com/docs/smtp-relay ; data centres: https://support.smtp2go.com/hc/en-gb/articles/227835308
- [S106] RFC 5321 §4.5.4.1, Sending strategy (retry for 4–5 days): https://www.rfc-editor.org/rfc/rfc5321#section-4.5.4.1
