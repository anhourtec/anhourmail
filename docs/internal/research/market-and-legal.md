# AnhourMail: billing, legal and market research

Date: 2026-10-21

> **Not legal or tax advice.** This is desk research from public sources, so confirm it with a Canadian accountant (GST/HST, BC PST, QST, foreign VAT) and a privacy or telecom lawyer before launch. Items marked **[UNVERIFIED]** could not be confirmed from a primary source on the research date. Prices were checked on 2026-10-21 unless a note says otherwise, and they change often.

Scope: Anhourtec (British Columbia) is launching AnhourMail, a hosted consumer email service. Plans are Free ($0, @anhourmail.com, 10 GB, limited sending, invite-only), Plus (US$12 / CA$15 per year), and Supporter (pay-what-you-want, $24+ per year). Billing is annual only, through Stripe, in CAD and USD, with a 14-day refund window.

---

## 1. Stripe

### 1.1 Fees for a Canadian Stripe account (standard pricing, from [stripe.com/en-ca/pricing](https://stripe.com/en-ca/pricing))

| Item | Fee |
|---|---|
| Domestic card | 2.9% + CA$0.30 per successful transaction |
| International card | +0.8% |
| Currency conversion (when conversion is required) | +2% |
| Manually entered card | +0.5% |
| Stripe Billing (pay as you go) | 0.7% of Billing volume |
| Stripe Tax (no-code) | 0.5% per transaction *where you are registered to collect* |
| Stripe Tax (API) | CA$0.50 per transaction (10 calc calls included) |
| Refunds | No refund fee, but the **original processing and FX fees are not returned** |
| Disputes | CA$15 per dispute received, plus CA$15 to counter (returned if you win) |
| Managed Payments (Stripe as merchant of record) | 3.5% **on top of** payment fees |

- **[UNVERIFIED]** For USD charges the fixed fee is presumably US$0.30. The pricing page lists CA$0.30 only, so confirm it in the Dashboard.
- You avoid the 2% conversion on USD sales by adding a USD bank account for USD payouts. Stripe charges conversion only "when currency conversion is required" ([pricing](https://stripe.com/en-ca/pricing)).

### 1.2 One Product, CAD + USD Prices

- One Price can carry several currencies via `currency_options`. Example: default `usd` 1200, plus `currency_options[cad][unit_amount]=1500`. Checkout then shows the customer's local currency automatically when every price in the session has that currency option. If you use Stripe Tax, each currency also needs a `tax_behavior` ([manual currency prices](https://docs.stripe.com/payments/checkout/localize-prices/manual-currency-prices.md?payment-ui=stripe-hosted)).
- You can force a currency by passing `currency` on the Checkout Session (same doc). Stripe recommends Adaptive Pricing over manual prices, but manual prices override it and fit a deliberate CA$15 / US$12 split.
- **A customer is locked to one currency** once they have an active subscription, discount, quote, etc. Stripe's workaround is a new Customer object ([Stripe support](https://support.stripe.com/questions/why-are-customers-locked-to-a-specific-currency-and-can-not-be-moved-to-a-price-in-another-currency)). For a single annual subscription this is fine, but don't let users switch currency later.
- Customer Portal limitation: **you can't have multiple Prices with the same `product` and `recurring.interval`** if the portal is to offer plan switching ([customer portal docs](https://docs.stripe.com/customer-management)). Model Plus and Supporter as **separate Products**, each with one yearly Price that carries CAD and USD.

### 1.3 Checkout vs Elements

- **Recommendation: hosted (or embedded) Checkout in `mode=subscription`.** It covers SCA/3DS, wallets, address collection for Stripe Tax (`billing_address_collection`, `automatic_tax`), currency localisation and `tax_id_collection` without custom UI ([Checkout Session API](https://docs.stripe.com/api/checkout/sessions/create)). `ui_mode` options include `hosted_page`, `embedded_page`, `form` and `elements`, so you can move to an embedded flow later without changing the billing model.
- Elements (PaymentElement plus your own Subscription creation) is only worth the extra work if you need full control of the page. Stripe's Managed Payments (merchant-of-record) does **not** support Elements or subscriptions created outside Checkout/Payment Links ([Managed Payments](https://docs.stripe.com/payments/managed-payments)), so Checkout also keeps that option open.
- Privacy note for this audience: Stripe-hosted pages load Stripe.js and fraud signals. Disclose Stripe as a processor in the privacy policy (see §3.6).

### 1.4 Customer Portal

Customers can update billing info and tax IDs, update payment methods, update or cancel subscriptions (immediately or at period end), and view, pay and download invoices. Optional cancellation reasons and a retention coupon are available. Sessions expire, and the portal **cannot be iframed** ([customer portal](https://docs.stripe.com/customer-management)). Configure it so Plus can't be switched to an arbitrary Supporter amount there (see 1.5).

### 1.5 Pay-what-you-want *annual subscription*: verified limitation and workarounds

- **Verified:** "Customer chooses price" (`custom_unit_amount`) **does not support recurring payments**. The pay-what-you-want doc lists, verbatim: "They don't support recurring payments or optional items." It also says no other line items, quantity 1, and no promotion codes ([pay-what-you-want](https://docs.stripe.com/payments/checkout/pay-what-you-want.md?payment-ui=stripe-hosted)). The Dashboard flow requires selecting **One-off**.
- **Workarounds (best first):**
  1. **Inline recurring price (recommended).** Your page has an amount input (min $24, validated server-side). The server creates a Checkout Session in `mode=subscription` with `line_items[0][price_data]` = `{currency, product: prod_supporter, unit_amount: <chosen>, recurring: {interval: "year"}, tax_behavior: "exclusive"}`. `price_data.recurring.interval` accepts `year` ([Checkout Session API, line_items.price_data](https://docs.stripe.com/api/checkout/sessions/create.md?query=line_items)). Renewals keep the same amount. To change the amount, update the subscription item through your own endpoint, not the portal. Inline prices can't be reused ([pay-what-you-want doc](https://docs.stripe.com/payments/checkout/pay-what-you-want.md?payment-ui=stripe-hosted)), which doesn't matter here.
  2. **Quantity trick.** Supporter Price = $1/yr with `adjustable_quantity {enabled, minimum: 24, maximum: 500}` ([same API ref](https://docs.stripe.com/api/checkout/sessions/create.md?query=line_items)). It's simple and portal-friendly, but Checkout shows "Qty 24 × $1", which looks odd.
  3. **Preset tiers.** Fixed Supporter Prices of $24, $48 and $96/yr, each a separate Product for portal compatibility. It's simplest to operate but isn't truly pay-what-you-want.

### 1.6 Stripe Tax for Canada

- Stripe Tax decides GST/HST vs PST/QST/RST per transaction from the customer location. **It only calculates for registrations you add in the Dashboard.** A normal GST/HST registration is required to collect federal tax ([Stripe Tax Canada](https://docs.stripe.com/tax/supported-countries/canada)).
- **Gotcha:** "Stripe only monitors if you've reached a tax threshold for sales outside the country your business is based in" ([same doc](https://docs.stripe.com/tax/supported-countries/canada)). For a Canadian business, Stripe will **not** warn you about the GST/HST $30k or BC PST $10k thresholds, so you have to track them yourself.
- Tax code: `txcd_10000000` (General – Electronically Supplied Services) or `txcd_10103000` (SaaS – personal use) are the closest fits ([tax code list](https://docs.stripe.com/payments/managed-payments/eligibility)). **[UNVERIFIED]** Stripe's codes may not map email to a BC "telecommunication service" (§2.4), so test the BC result and override it with a manual rate if needed.
- Stripe can file only *simplified* (non-resident) GST/HST returns. A BC-resident business files its own GST/HST and PST returns, or uses a filing partner ([Stripe Tax Canada](https://docs.stripe.com/tax/supported-countries/canada)).

### 1.7 Dunning / Smart Retries

- Smart Retries is AI-timed, and the recommended default is **8 tries within 2 weeks**. Windows are configurable from 1 week to 2 months. Hard declines (`lost_card`, `stolen_card`, `authentication_required`, etc.) aren't retried until a new payment method arrives ([Smart Retries](https://docs.stripe.com/billing/revenue-recovery/smart-retries)).
- When retries run out you can cancel, mark unpaid, leave past_due, or pause (same doc). For an annual email plan, **pause or downgrade-to-Free with a grace period** is kinder than cancelling and deleting mail.
- Turn on Stripe's renewal reminder emails and the `invoice.upcoming` lead time. Several days' notice before an annual renewal reduces "surprise renewal" refund requests and disputes (CA$15 each).

### 1.8 Webhooks to handle (from [subscription webhooks](https://docs.stripe.com/billing/subscriptions/webhooks))

| Event | Action |
|---|---|
| `checkout.session.completed` | Link the Stripe customer and subscription to the account (store IDs only) |
| `invoice.paid` | Extend `paid_until`; confirm `subscription.status=active` first |
| `invoice.payment_failed` | Notify the user; read `attempt_count` / `next_payment_attempt` |
| `invoice.payment_action_required` | Email the SCA link |
| `invoice.upcoming` | Send a renewal notice (annual, so required for good UX) |
| `invoice.finalization_failed` | Stripe Tax location problem (`requires_location_inputs`); ask for an address |
| `customer.subscription.created/updated/deleted/paused/resumed` | Entitlement state machine; revoke Plus on `canceled`/`unpaid` |
| `charge.refunded`, `charge.dispute.created`, `radar.early_fraud_warning.created` | Refund flow; abuse and fraud handling (e.g. a stolen-card Plus used for spam) |
| `customer.updated` | Only if you mirror customer data locally |

Verify signatures, process idempotently by `event.id`, and respond 2xx fast. If `invoice.created` gets no response, Stripe delays finalisation up to 72 h (same doc).

### 1.9 Refunds (14-day window)

Refunds return the charge but **not** Stripe's processing or FX fees ([pricing](https://stripe.com/en-ca/pricing)). Every 14-day refund on Plus costs about US$0.75–1.07 (§6). Issue refunds through the API (`refunds.create`), cancel the subscription immediately, and downgrade to Free. Refunding proactively when asked is much cheaper than a dispute (CA$15 + CA$15).

---

## 2. Canadian sales tax (GST/HST, BC PST, QST) and foreign taxes

### 2.1 GST/HST small-supplier threshold

- **Verified (CRA):** you're a small supplier if worldwide taxable supplies (including zero-rated, and including associates) don't exceed **$30,000 over four consecutive calendar quarters**. If you exceed $30k in **a single quarter**, you must charge tax on the supply that crosses the line, and registration is effective that day. If you exceed it over four quarters, you stop being a small supplier at the end of the following month ([CRA: When to register](https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/when-register-charge)). Voluntary registration is allowed (same page).
- Scale check: CA$30k is roughly 2,000 Plus subscriptions, or a mix with Supporters.

### 2.2 Register voluntarily?

| Register now | Stay small supplier |
|---|---|
| Claim input tax credits (ITCs) on GST/HST paid on servers, domains, SaaS, hardware | No collection, filing or remittance |
| Foreign customers are generally zero-rated anyway (§2.6), so exports cost nothing | Canadian prices stay "all-in" (CA$15) |
| Looks established; Stripe Tax ready from day 1 | Must monitor $30k yourself (Stripe won't, §1.6) |
| Canadian consumers pay 5–15% more; filing burden | Can't recover GST paid on expenses |

**Suggested approach:** stay a small supplier at launch unless start-up spend with GST (hardware, colocation) is large enough that the ITCs justify the filing work. Even so, **set all Prices `tax_behavior: exclusive` from day 1** and build Stripe Tax into Checkout, so registering later is a configuration change and not a price change. Review quarterly, and register before you reach about CA$25k trailing four quarters. Confirm with an accountant.

### 2.3 Place of supply and rates for Canadian consumers in other provinces

- Email hosting is very likely **not** a GST "telecommunication service": CRA says a supply that merely uses telecom facilities as an input, "such as a supply of a website hosting service," is not one ([GST/HST Memo 3-3-6-1, para. 59–61](https://www.canada.ca/en/revenue-agency/services/forms-publications/publications/3-3-6-1/plc-spply-prvnc-prsnl-srvcs-srvcs-rltn-prprty-nd-tlcmmnctn-srvcs.html)). **[UNVERIFIED for email specifically]** The memo doesn't mention email, so confirm this.
- Under the general services rule, the province of supply is the **recipient's home/business address obtained in the ordinary course**, and if only a billing address is known, that address ([CRA place-of-supply rules](https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/charge-collect-place-supply.html); [Memo 3-3-6](https://www.canada.ca/en/revenue-agency/services/forms-publications/publications/3-3-6/plc-spply-prvnc-gnrl-rls-fr-srvcs.html)). Collect a billing address in Checkout.
- Rates from 1 April 2025 ([CRA rate table](https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/charge-collect-which-rate/calculator.html)): ON 13% HST, **NS 14%** (cut from 15% on 2025-04-01), NB/NL/PE 15%, all others 5% GST (plus provincial PST/QST where applicable: BC 7%, MB 7%, SK 6%, QC 9.975%).

### 2.4 BC PST: email **is** taxable

- **Verified:** BC's definition of telecommunication services lists "internet access, **email**, text, and picture and video messaging services". PST is **7%**, and the test is whether the device is "ordinarily situated" in BC. Billing address is acceptable for stationary devices, and billing address, area code or IP for mobile ([BC: Telecommunication services](https://www2.gov.bc.ca/gov/content/taxes/sales-taxes/pst/publications/telecommunication-services)). Web hosting is taxed as software (SaaS/IaaS, retroactive amendment noted by [Ryan, 2024](https://ryan.com/canada/about-ryan/news-and-insights/2024/british-columbia-updates-software-telecom-services/)), and bundles follow the bundled-sale rules (same BC page).
- **Registration:** a business **located in BC** that provides software or telecommunication services in BC generally must register. The exception is a **small seller**: located in BC, no established business premises/storefront, and **≤ $10,000** gross revenue from retail sales of eligible goods, software and services in the previous 12 months *and* the next 12 months ([PST Bulletin 001, revised Oct 2026](https://www2.gov.bc.ca/assets/gov/taxes/sales-taxes/publications/pst-001-registering-to-collect-pst.pdf)). Out-of-BC Canadian sellers register above $10k of BC sales (same bulletin).
- **[UNVERIFIED]** Whether the $10k small-seller test counts only BC-customer revenue or all revenue, and whether a home office counts as an "established business premises". See Bulletin PST 003, *Small Sellers*, and ask the Ministry (CTBTaxQuestions@gov.bc.ca). **This is the threshold most likely to bite first**, and it is a third of the GST threshold.

### 2.5 Quebec QST, Manitoba, Saskatchewan

- QST: suppliers outside Québec register under the **specified (simplified) system** once taxable supplies to specified Québec consumers exceed **$30,000 over 12 months** ([Revenu Québec](https://www.revenuquebec.ca/en/businesses/consumption-taxes/gsthst-and-qst/special-cases-gsthst-and-qst/suppliers-outside-quebec/qst-registration-for-suppliers-outside-quebec/registration-under-the-specified-system-suppliers-outside-quebec-who-are-registered-under-the-general-gsthst-system/)). This is irrelevant at launch scale.
- **[UNVERIFIED]** Manitoba RST and Saskatchewan PST also tax telecommunication and computer services and have their own out-of-province registration rules. Check them before Canadian revenue in those provinces becomes material.

### 2.6 Foreign customers

- **Canada side:** services supplied to a non-resident are generally **zero-rated** (Sched. VI, Part V, s.7), **except** where the service is rendered to an individual *while in Canada* or the individual is in Canada when contacting the supplier ([CRA Memo 4-5-3](https://www.canada.ca/en/revenue-agency/services/forms-publications/publications/4-5-3/exports-services-intangible-personal-property.html)). If registered, charge 0% to foreign customers with a foreign billing address. Travellers are an edge case, so ask your accountant.
- **US:** most states set economic nexus at **$100,000** of sales (some higher), and SaaS/digital taxability varies by state ([TaxCloud nexus guide](https://taxcloud.com/blog/sales-tax-nexus-by-state/), [Beancount 2026 overview](https://beancount.io/blog/2026/05/14/sales-tax-saas-streaming-digital-goods-2026-true-object-test-economic-nexus-wayfair-state-by-state-compliance-guide)). **No obligation at our scale.** Revisit if any single state approaches US$100k.
- **EU:** the €10,000 cross-border threshold is available only to suppliers **established in an EU Member State** ([Revenue.ie](https://revenue.ie/en/vat/vat-on-services/electronic-services/vat-and-electronically-supplied-services/index.aspx); [Vertex](https://www.vertexinc.com/resources/resource-library/2019-eu-vat-changes-part-1-origin-taxation-less-evidence)). Non-EU suppliers of B2C electronically supplied services owe VAT **from the first euro** and can use the **non-Union OSS** in one Member State ([Revenue.ie non-Union OSS](https://www.revenue.ie/en/tax-professionals/tdm/value-added-tax/part10-special-schemes/vat-ecommerce-rules/non-union-scheme-one-stop-shop-oss.pdf)). **[UNVERIFIED against the EU primary text]**: the Commission page could not be retrieved.
- **UK:** non-established businesses selling digital services to UK consumers have **no registration threshold** (HMRC forum answers: [1](https://community.hmrc.gov.uk/customerforums/vat/15f99cef-69c1-ee11-a81c-000d3a0d1900), [2](https://community.hmrc.gov.uk/customerforums/vat/2095f20b-d233-ef11-a81d-6045bd0b6b38); [Quaderno](https://quaderno.io/guides/united-kingdom/vat/registration/)). **[UNVERIFIED against GOV.UK guidance]**
- **Practical options for EU/UK:** (a) register non-Union OSS + UK VAT and let Stripe Tax calculate; (b) use **Stripe Managed Payments** (Stripe is merchant of record, Canada is an eligible business location, and "electronically supplied ... web services" are eligible) for **+3.5%** ([eligibility](https://docs.stripe.com/payments/managed-payments/eligibility), [pricing](https://stripe.com/en-ca/pricing)); (c) knowingly carry the small-scale risk until EU/UK revenue justifies registration. Option (b) is the low-effort compliant path, but it costs about $0.42 on a $12 sale.

---

## 3. Privacy law

### 3.1 PIPEDA vs BC PIPA: which applies

- BC PIPA applies to "every organization" in BC, subject to exclusions ([PIPA s.3](https://www.bclaws.gov.bc.ca/civix/document/id/complete/statreg/03063_01)). PIPEDA Part 1 applies to personal information collected, used or disclosed "in the course of commercial activities" ([PIPEDA s.4](https://laws-lois.justice.gc.ca/eng/acts/P-8.6/FullText.html)).
- The OPC says BC organizations subject to PIPA "also have to follow PIPEDA for those specific transactions" that cross provincial or national borders. Where the complaint is about collection or use within BC, PIPA applies and the cross-border flow is "incidental" ([OPC: PIPEDA in BC/Alberta](https://www.priv.gc.ca/en/privacy-topics/privacy-laws-in-canada/the-personal-information-protection-and-electronic-documents-act-pipeda/r_o_p/02_05_d_26/)).
- **Conclusion:** comply with **both**. BC PIPA governs Anhourtec's own collection and use, overseen by the BC OIPC. PIPEDA governs interprovincial and international commercial flows (customers in other provinces or abroad, US processors such as Stripe), overseen by the OPC. In practice, design to the **stricter of the two** on each point. PIPEDA's breach regime is the stricter one.

### 3.2 Key obligations

| Topic | PIPEDA | BC PIPA |
|---|---|---|
| Privacy officer | Must designate accountable individual(s) (Sched. 1, Principle 4.1) ([PIPEDA](https://laws-lois.justice.gc.ca/eng/acts/P-8.6/FullText.html)) | Must designate, with contact info public (s.4(3), 4(5)) ([PIPA](https://www.bclaws.gov.bc.ca/civix/document/id/complete/statreg/03063_01)) |
| Access requests | Respond within **30 days**, extendable by 30 (s.8(3)–(4)) | Respond within **30 days**, where "day" excludes Saturdays and holidays (s.29, s.1) |
| Breach reporting | **Mandatory** report to OPC and notify individuals when a breach creates a **real risk of significant harm (RROSH)**; keep records of **all** breaches for **24 months**; knowing failure is an offence ([OPC breach guidance](https://www.priv.gc.ca/en/privacy-topics/business-privacy/breaches-and-safeguards/privacy-breaches-at-your-business/gd_pb_201810/); PIPEDA s.10.1–10.3) | **No mandatory breach notification** in PIPA as of the research date (security duty only, s.34) ([PIPA text](https://www.bclaws.gov.bc.ca/civix/document/id/complete/statreg/03063_01); OIPC has long recommended adding it, see [Torys 2020](https://www.torys.com/en/our-latest-thinking/publications/2020/10/british-columbia-privacy-czar-recommends-reforms-to-privacy-legislation), [Gowling 2024](https://gowlingwlg.com/en/insights-resources/articles/2024/alberta-and-british-columbia-privacy-law-2024-year-in-review)) |
| Retention | Keep only as long as needed; keep info used for a decision long enough for access | Keep info used to make a decision about someone for at least **one year** **[UNVERIFIED period, s.35 text not quoted]**; destroy or de-identify when no longer needed (s.35) |
| Consent | Meaningful consent, purpose limitation | Consent, with notice of purposes (ss.6–8) |

**Practical:** name a privacy officer (privacy@anhourmail.com), publish a privacy policy that lists processors and their countries, run a breach log from day 1 (PIPEDA s.10.3), use a RROSH assessment template, set a 30-day DSAR SLA, and write a retention schedule (logs, deleted-account mail, billing records). CRA requires business records to be kept for 6 years, which is a separate obligation **[not re-verified]**.

### 3.3 Reform status: Bill C-27 to Bill C-36

- **C-27** (CPPA/AIDA) died when Parliament was prorogued on 6 Jan 2025 ([Gowling timeline](https://gowlingwlg.com/en/insights-resources/articles/2024/bill-c27-timeline-of-developments)).
- **Successor: Bill C-36, *Protecting Privacy and Consumer Data Act*,** introduced **15 June 2026**. LEGISinfo shows it **at second reading in the House**, with no activity after first reading ([LEGISinfo C-36](https://www.parl.ca/legisinfo/en/bill/45-1/c-36); [ISED backgrounder](https://www.canada.ca/en/innovation-science-economic-development/news/2026/06/government-of-canada-introduces-legislation-to-protect-canadians-privacy-in-the-digital-age.html)). It would replace PIPEDA Part 1, move enforcement to a new Digital Safety and Data Protection Commission, and add a limited private right of action ([DLA Piper](https://www.dlapiper.com/en/insights/publications/2026/06/canada-tables-bill-c36-the-protecting-privacy-and-consumer-data-act), [Osler](https://www.osler.com/en/insights/reports/the-protecting-privacy-and-consumer-data-act-bill-c-36-key-obligations-and-enforcement-overview/)). **PIPEDA remains the law.** Design for C-36-style obligations (de-identification, disposal on request, plain-language notices), because they're likely to arrive within the product's life.

### 3.4 Lawful access

- **Domestic:** police use Criminal Code **production orders (s.487.014)** directed at a person with possession or control of the data. Canadian courts have also stretched these to foreign providers with a "virtual presence" (R v Love, leave to SCC denied 2023), and the OVHcloud case shows enforcement against hosts ([Mondaq](https://mondaq.com/canada/trials-appeals-compensation/1391742/expanding-the-scope-of-production-orders-virtual-presence-brings-data-around-the-world-into-the-purview-of-canadian-law-enforcement); [OVHcloud statement](https://blog.ovhcloud.com/en/posts/ovhcloud-contests-canadian-production-order-charges/)). As a BC-hosted provider, expect Canadian orders to be directly enforceable against you.
- **Foreign requests** (US subpoenas, etc.) should go through **MLAT** to Canada's Department of Justice. Publish a policy saying you require Canadian legal process ([Michael Geist on MLAT](https://www.michaelgeist.ca/tag/mlat/); [CBA on a CLOUD Act agreement](https://cba.org/Our-Work/Submissions-(1)/Submissions/2024/November/Cloud-Act-Agreement)). A Canada–US CLOUD Act agreement was under negotiation **[status UNVERIFIED]**.
- **Watch: Bill C-22, *Lawful Access Act, 2026*.** It passed the House on 18 June 2026 and is **at second reading in the Senate** (debated 20 Oct 2026), with no royal assent yet ([LEGISinfo C-22](https://www.parl.ca/legisinfo/en/bill/45-1/c-22)). Part 2 (*Supporting Authorized Access to Information Act*) can impose capability and assistance obligations on **"electronic service providers"** by regulation or ministerial order. It does not compel decrypting data unless the provider supplied the encryption and holds the keys ([Fasken](https://www.fasken.com/en/knowledge/2026/03/the-government-of-canada-introduces-bill-c22), [CBA submission](https://cba.org/our-impact/submissions/bill-c-22-lawful-access-act-2026/bill-c-22-lawful-access-act-2026)). An email host is squarely an ESP. **This is the most important pending law for AnhourMail.** Architecture choices (e.g. user-held keys for at-rest encryption) and any transparency or "warrant canary" plans need legal review against it.
- Publish a **transparency report and law-enforcement guidelines**. This audience expects both.

### 3.5 Telecommunications Act

The Act's "telecommunications common carrier" is someone who "owns or operates a transmission facility" to offer service to the public, and a "telecommunications service provider" provides basic telecommunications services ([Telecommunications Act s.2](https://laws-lois.justice.gc.ca/eng/acts/T-3.4/page-1.html)). A mail host renting servers and buying transit from carriers is **likely neither**. That means no CRTC registration and no Telecom Act privacy rules, although C-22 ESP duties would still apply. **[UNVERIFIED: confirm with counsel]**

### 3.6 US-owned vendors and cross-border transfers

- OPC's guidelines say a transfer to a processor is a **use**, governed by **accountability**: use "contractual or other means to provide a comparable level of protection". Make it "plain to individuals that their information may be processed in a foreign country", ideally at collection, including that it "may be accessible to the foreign jurisdiction's law enforcement and national security authorities". The OPC kept this position after its 2019 consultation ([OPC 2009 guidelines](https://www.priv.gc.ca/en/privacy-topics/personal-information-transferred-across-borders/gl_dab_090127/), [OPC 2019 announcement](https://priv.gc.ca/en/opc-news/news-and-announcements/2019/an_190923)).
- **Do:** list Stripe (and any SMS/OTP, error-tracking or CDN provider) with country of processing in the privacy policy and at signup or checkout; sign DPAs; minimise what you send (no mailbox data to Stripe, only email and billing address). Prefer passkeys/TOTP over SMS to avoid a US SMS vendor holding phone numbers.

---

## 4. CASL (Canada's Anti-Spam Legislation)

### 4.1 Does CASL make the host liable for users' spam?

- **s.6(7):** s.6 "does not apply to a telecommunications service provider **merely because** the service provider provides a telecommunications service that enables the transmission of the message" ([CASL full text](https://laws-lois.justice.gc.ca/eng/acts/E-1.6/FullText.html)). This covers *mere conduit* activity only.
- **s.9:** it is prohibited to "aid, induce, procure or cause to be procured" any contravention of ss.6–8 (same text). The CRTC's **Compliance and Enforcement Information Bulletin 2018-415** names **telecom/Internet service providers and web hosting providers** among potential s.9 intermediaries. It says knowledge or intent isn't strictly required and expects **proactive** measures ([CRTC 2018-415](https://crtc.gc.ca/eng/archive/2018/2018-415.htm); commentary: [Dentons](https://www.dwpv.com/en/Insights/Publications/2018/Whose-Liability-Is-It-Anyway), [Mondaq](https://www.mondaq.com/canada/telecoms-mobile-cable-communications/764348/digital-intermediaries-responsibility-for-unknown-casl-violations)). No court has endorsed that reading yet.
- Maximum administrative monetary penalties are **$1M (individual) / $10M (other persons)** per violation ([CASL s.20(4)](https://laws-lois.justice.gc.ca/eng/acts/E-1.6/FullText.html)).

**Posture:** treat s.6(7) as a partial shield only, and show "reasonable steps":
- An AUP that prohibits CEMs without consent, purchased or scraped lists, missing sender ID or unsubscribe, malware or phishing (ss.6–8), bulk or marketing sending from Free accounts, open relays and spoofing.
- Rate and recipient limits (the existing "limited sending" on Free is good), invite-only Free, outbound spam scoring, and an abuse@ address with feedback loops (FBLs) and a documented takedown SLA.
- A record of abuse reports and action taken.
- Prompt suspension on credible complaints.

### 4.2 Our own email (waitlist, invites, product news)

- Express consent requests must state the purpose, who is seeking consent and contact info, and that consent can be withdrawn (s.10(1)). The **sender bears the onus of proving consent** (s.13) ([CASL text](https://laws-lois.justice.gc.ca/eng/acts/E-1.6/FullText.html)). Store a timestamp, IP, form version or wording, and the source for each signup.
- Every CEM needs sender identification plus an unsubscribe mechanism (s.6(2)). Contact info must stay valid for **60 days** (s.6(3)), and unsubscribes must take effect **within 10 business days** (s.11(3)) (same text).
- Waitlist **confirmation (double opt-in)** and purely transactional messages (receipts, renewal notices, security alerts, invite codes the user asked for) aren't marketing. Keep them free of promotional content. Send product news only to people who ticked an unticked "send me updates" box.
- Service-account notices (renewal reminders, breach notices) are fine without marketing consent.

### 4.3 Private right of action

CASL's private right of action (ss.47–51) was suspended in 2017 ([Osler](https://www.osler.com/en/insights/updates/canadian-government-suspends-casl-private-right-of/)). The current consolidated statute on Justice Laws now shows **ss.47–51 "[Repealed before coming into force, 2008, c. 20, s. 3]"**, i.e. repealed under the *Statutes Repeal Act* ([CASL full text](https://laws-lois.justice.gc.ca/eng/acts/E-1.6/FullText.html)). **No private class-action route under CASL. Enforcement is CRTC, Competition Bureau and OPC only.** (Secondary sources still describe it as "suspended" because they predate this.)

---

## 5. Market scan (checked 2026-10-21 unless noted)

Providers are described by type, not named, in this public doc (CLAUDE.md rule 57). The named table, quotes and
links are kept locally in `docs/internal/private/competitors/market-and-legal.named-2026-10-22.md` (gitignored).

### 5.1 Price and feature ranges

| Provider type | Cheapest relevant paid plan (annual) | Storage | Custom domains | Aliases / masked | Send limits | IMAP / JMAP |
|---|---|---|---|---|---|---|
| **AnhourMail Plus** | **US$12 / CA$15** | 30 GB | Yes | Unlimited + catch-all + masked | TBD | Planned |
| Low-cost, one-operator provider (US) | ~US$10/yr flat; heavy users moved to usage pricing (~US$0.56/GB-yr + US$4/yr account fee) | Soft, "no hard limits" | Unlimited | Yes (routing rules) | Rate limiting on large external sends | IMAP/SMTP |
| Privacy-focused, end-to-end providers (EU/CH) | ~US$36–48/yr; top tiers ~US$120/yr | 15–20 GB (free tiers 1 GB) | 1–3 | 10–15 addresses + alias add-ons | Free: ~150/day | **IMAP only via a paid local bridge, or not at all** |
| Established JMAP provider (AU) | ~US$60/yr and rising | 60 GB | Yes | Aliases + masked | n/a | IMAP + **JMAP** |
| Multi-domain budget host (CH) | ~US$19/yr; ~US$90/yr next tier | 5–30 GB, soft | "Almost unlimited" | Unlimited addresses | **20 out / 200 in per day** on the cheapest tier | IMAP |
| European privacy hosts (DE/NL) | ~€12–36/yr; ~US$60–84/yr for some | 4–30 GB | Varies (some none) | 2–unlimited | n/a | IMAP/SMTP |
| Alias-only forwarding services | ~US$12–36/yr on top of a mailbox | — | 1–unlimited | Unlimited aliases, catch-all | — | Forwarder |
| Free tiers of business suites | Free; ~US$1/user/mo paid | ~5 GB/user | 1 | — | — | **No IMAP on free** |

### 5.2 What communities praise and complain about

Reddit search results were not retrievable on the research date, so the evidence is from Hacker News (via the Algolia API), Lemmy and the Techlore forum. **[Reddit sentiment UNVERIFIED]**

- **Low-cost one-operator provider.** Praised for price and reliability. The persistent complaint is **bus factor** ("one person show") and a rough UI. In 2025 the founder sold the service, with prices held for now and grandfathering promised if they change — which validates the bus-factor fear and shows price-change uncertainty.
- **Privacy-focused end-to-end providers.** IMAP needing a paid local bridge, or no IMAP/SMTP at all, is the dominant and recurring complaint (into 2026); export only on paid plans. The stated reason is end-to-end encryption.
- **Established JMAP provider.** Respected, but **price** draws complaints (a ~42% increase discussed in Aug 2026). Local-currency billing was welcomed.
- **Multi-domain budget host.** Loved for flat multi-domain pricing, but **daily send limits** ("20 outgoing emails") put people off.
- **Alias services.** Paying for both an alias service ($12–36) and a mailbox doubles cost and adds a dependency; some have no-refund policies, against our 14-day window.

### 5.3 The gap AnhourMail fills

**"Budget-provider price, standard protocols, built-in alias/masked addresses, a polished UI, and Canadian jurisdiction, from a company that isn't one person."**

- Cheapest *full* package: custom domains + unlimited aliases + catch-all + masked aliases + 30 GB for US$12. Matching this today means a ~US$10 provider with no masked-alias UX, a US$48–60 provider, or a mailbox plus an alias service ($12–36 extra).
- **IMAP/SMTP (and ideally JMAP) on every paid plan, with no bridge.** This directly answers the top complaints about privacy-focused providers.
- **No punitive daily send caps on Plus.** Use reputation-based throttling instead of a hard 20/day.
- **Canadian jurisdiction** is a real differentiator against US, EU and Swiss options for Canadian users and for anyone wanting a non-US, non-EU option. Be honest about C-22 (§3.4), because this audience will ask.
- **Bus-factor answers:** publish a continuity plan (escrowed credentials, a documented export path, at least 2 operators), standard IMAP export, and custom-domain portability.

---

## 6. Is US$12/yr Plus sustainable?

### 6.1 Stripe fees per sale (from §1.1; tax pass-through excluded)

| Scenario | Gross | Stripe fees | % | Net |
|---|---|---|---|---|
| Canadian card, CA$15, registered + Stripe Tax no-code | CA$15.00 | 0.435 + 0.30 + Billing 0.105 + Tax 0.075 = **CA$0.92** | 6.1% | CA$14.09 |
| Canadian card, CA$15, not tax-registered | CA$15.00 | **CA$0.84** | 5.6% | CA$14.16 |
| US card, US$12, USD payout account (no FX) | US$12.00 | 3.7% (0.444) + 0.30* + Billing 0.084 = **US$0.83** | 6.9% | US$11.17 |
| US card, US$12, converted to CAD | US$12.00 | + 2% FX (0.24) = **US$1.07** | 8.9% | US$10.93 |
| Same + Managed Payments (EU/UK tax handled) | US$12.00 | + 3.5% (0.42) = **US$1.49** | 12.4% | US$10.51 |
| Supporter US$24, US card, converted | US$24.00 | 1.368 + 0.30 + 0.168 = **US$1.84** | 7.7% | US$22.16 |
| 14-day refund on US$12 | 0 | fees not returned | — | **−US$0.83 to −1.07** |
| Dispute | — | CA$15 + CA$15 to fight | — | **−CA$15 to −30** |

\*Assumes a US$0.30 fixed fee for USD charges. **[UNVERIFIED]**

Takeaways: annual billing is right, since the fixed fee is only about 2.5% of $12 (at $1/month it would be about 30%). **Add a USD bank account** to save 2% on the USD side. A single dispute wipes out the margin of about 2–3 subscriptions, so prioritise renewal reminders and easy refunds.

### 6.2 Storage cost

- Object storage list price: Backblaze B2 **US$6.95/TB-month**, about US$0.083/GB-year ([B2 pricing](https://www.backblaze.com/cloud-storage/pricing)). B2 lists a CA-East region, but its regional price is **[UNVERIFIED]**. OVHcloud Object Storage in Beauharnois was announced at about €7/TB-month **[old announcement, UNVERIFIED current]** ([IT Europa](https://iteuropa.com/news/ovhcloud-launches-new-object-storage-solution)).
- With 3× (primary SSD/replica plus backup) at about US$0.25/GB-year:
  - Plus at the **full 30 GB** costs about **US$7.50/yr**, while typical use (~3–5 GB) costs about US$1/yr **[usage assumption]**.
  - Free at the **full 10 GB** costs about **US$2.50/yr**, with no revenue.
- Market benchmark: the cheapest low-cost provider's *usage* rate (cost plus margin) is US$0.56/GB-yr plus a US$4 account fee. At that rate a 30 GB user would cost **US$20.80/yr**, above our Plus price. Its own ~$10 plan only works because most users are small, and it reserves the right to move heavy users.
- The real costs are fixed: IP reputation and deliverability work, anti-abuse, backups, on-call, and support. These don't scale with storage. **[No primary-source infra quotes gathered for BC/Canadian VPS; get OVH BHS / Canadian colo quotes.]**

### 6.3 Verdict and recommendations on price and plan structure

US$12 is **viable as a launch or founding price but thin as the long-term list price**. Net revenue is about US$11, worst-case storage is about US$7.50 at full 30 GB, and fixed costs need roughly 150–300 paying users just to cover a modest CA$2–4k/yr in infrastructure **[rough assumption]**.

1. **Keep US$12/yr as a "founding member" price, locked for life or 3 years for early users.** Announce the standard price up front at **US$15 / CA$20**. That is still about 70% below the privacy-focused providers (~US$48) and 75% below the established JMAP provider (US$60), and in line with a budget mailbox plus an alias service.
2. **CAD/USD parity:** CA$15 vs US$12 is about a 9% discount for Canadians at ~1.37 CAD/USD **[FX rate assumed, check on the day]**. That works as an intentional home-market discount. Otherwise set **CA$16 founding / CA$20 standard**. Make all prices **tax-exclusive** so a later GST/HST registration doesn't eat margin.
3. **Make 30 GB a soft quota**, with paid storage add-ons (e.g. +50 GB for $X/yr) and an AUP clause about heavy use, as budget providers do.
4. **Cut Free storage from 10 GB to 1–5 GB.** Privacy-focused providers' free tiers give 1 GB. Keep Free invite-only with tight send limits, since Free is the main spam-liability vector (§4.1) and costs storage with no revenue.
5. **Supporter minimum US$24 is fine** at about 7.7% fees. Use the inline `price_data` recurring pattern (§1.5) and show suggested amounts ($24/$48/$96).
6. **No monthly plan and no lifetime deals.** Both are confirmed as correct by the fee maths and the tail storage risk.
7. **Absorb Stripe fees.** Don't add a surcharge, which is unusual and off-putting for consumers.

---

## Recommendations for AnhourMail

**Billing (Stripe)**
- Use two Products: **Plus** (one yearly Price, USD default + CAD `currency_options`, `tax_behavior=exclusive`) and **Supporter** (inline `price_data` yearly price, min $24, server-validated). Free stays outside Stripe.
- Use hosted/embedded **Checkout** in subscription mode with `automatic_tax` and billing address collection, plus the **Customer Portal** for card updates, invoices and cancellation. Disable plan switching to Supporter in the portal.
- Enable **Smart Retries** (8 tries / 2 weeks), renewal reminders and `invoice.upcoming` emails. On final failure, **downgrade to Free with a grace period**. Don't delete mail.
- Handle the webhooks in §1.8, add a USD payout account, and keep only Stripe IDs in the database.

**Tax**
- At launch: stay a GST/HST small supplier (or register voluntarily if ITCs are material). **Get a BC PST ruling or accountant view now**, because email is a taxable telecom service at 7% and the BC small-seller threshold is only $10k.
- Track the thresholds yourself (Stripe won't for domestic). Set reviews at CA$8k (BC PST) and CA$25k (GST/HST).
- Decide on EU/UK: Managed Payments (+3.5%) vs non-Union OSS + UK VAT vs accepted risk. Revisit at the first meaningful EU/UK revenue.

**Privacy**
- Comply with both PIPA and PIPEDA, and apply PIPEDA breach rules (RROSH reporting, 24-month breach log) to everyone.
- Name a privacy officer; publish a privacy policy with a processor/country list and foreign-access notice, a retention schedule, LE guidelines and a transparency report.
- Get legal review of **Bill C-22** obligations before finalising encryption and key-management architecture, and watch **Bill C-36**.

**CASL / abuse**
- Publish an AUP (no unsolicited CEMs, no bought lists, no phishing/malware, no bulk sending on Free) with an abuse@ desk, FBLs, rate limits and takedown records.
- For our own email: unticked consent box, double opt-in, consent records (s.13 onus), unsubscribe honoured in ≤10 business days, and no promo in transactional mail.

**Positioning**
- "Full IMAP/SMTP on every paid plan, unlimited masked aliases included, Canadian-run, not a one-person shop, at budget-provider prices."
- Publish a continuity plan and an export guarantee to neutralise the bus-factor objection.

---

## Flagged / unverified items

- Stripe fixed fee for USD-denominated charges on a Canadian account (assumed US$0.30).
- Stripe Tax's treatment of BC PST for email under `txcd_10000000`/SaaS codes (test before launch).
- BC PST small-seller test: BC-only vs total revenue; whether a home office is an "established business premises".
- Whether email hosting is a "telecommunication service" for **GST/HST** place-of-supply (CRA memo covers web hosting, not email).
- Manitoba RST / Saskatchewan PST registration rules for out-of-province telecom or computer services.
- EU non-Union OSS "from first euro" and UK NETP "no threshold" are from secondary or HMRC-forum sources, not checked against EU or GOV.UK primary texts.
- BC PIPA s.35 one-year retention period (text paraphrased, not quoted); CRA six-year record retention.
- Canada–US CLOUD Act agreement status.
- Telecommunications Act status of an email host (likely not a TSP or common carrier).
- Some providers' yearly EUR totals and current prices; open-source status and jurisdiction of some providers (details in the local named copy).
- Reddit community threads (not retrievable; HN, Lemmy and Techlore used instead).
- Storage and VPS prices in Canadian regions; typical per-user mailbox usage; CAD/USD rate.

---

## Sources

**Stripe**
- Pricing (Canada): https://stripe.com/en-ca/pricing
- Pay what you want: https://docs.stripe.com/payments/checkout/pay-what-you-want.md?payment-ui=stripe-hosted
- Manual currency prices: https://docs.stripe.com/payments/checkout/localize-prices/manual-currency-prices.md?payment-ui=stripe-hosted
- Currency lock on customers: https://support.stripe.com/questions/why-are-customers-locked-to-a-specific-currency-and-can-not-be-moved-to-a-price-in-another-currency
- Checkout Session API: https://docs.stripe.com/api/checkout/sessions/create and https://docs.stripe.com/api/checkout/sessions/create.md?query=line_items
- Customer portal: https://docs.stripe.com/customer-management
- Smart Retries: https://docs.stripe.com/billing/revenue-recovery/smart-retries
- Subscription webhooks: https://docs.stripe.com/billing/subscriptions/webhooks
- Stripe Tax Canada: https://docs.stripe.com/tax/supported-countries/canada
- Managed Payments: https://docs.stripe.com/payments/managed-payments and https://docs.stripe.com/payments/managed-payments/eligibility

**Canadian and foreign tax**
- CRA, when to register: https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/when-register-charge
- CRA, GST/HST rates: https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/charge-collect-which-rate/calculator.html
- CRA, place of supply: https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/charge-collect-place-supply.html
- CRA Memo 3-3-6: https://www.canada.ca/en/revenue-agency/services/forms-publications/publications/3-3-6/plc-spply-prvnc-gnrl-rls-fr-srvcs.html
- CRA Memo 3-3-6-1: https://www.canada.ca/en/revenue-agency/services/forms-publications/publications/3-3-6-1/plc-spply-prvnc-prsnl-srvcs-srvcs-rltn-prprty-nd-tlcmmnctn-srvcs.html
- CRA Memo 4-5-3 (exports): https://www.canada.ca/en/revenue-agency/services/forms-publications/publications/4-5-3/exports-services-intangible-personal-property.html
- BC, telecommunication services: https://www2.gov.bc.ca/gov/content/taxes/sales-taxes/pst/publications/telecommunication-services
- BC PST Bulletin 001: https://www2.gov.bc.ca/assets/gov/taxes/sales-taxes/publications/pst-001-registering-to-collect-pst.pdf
- Ryan, BC software/telecom bulletins 2024: https://ryan.com/canada/about-ryan/news-and-insights/2024/british-columbia-updates-software-telecom-services/
- Lawson Lundell, BC out-of-province PST: https://lawsonlundell.com/the-business-law-blog/BC-expands-out-of-province-pst-requirements
- Revenu Québec, specified system: https://www.revenuquebec.ca/en/businesses/consumption-taxes/gsthst-and-qst/special-cases-gsthst-and-qst/suppliers-outside-quebec/qst-registration-for-suppliers-outside-quebec/registration-under-the-specified-system-suppliers-outside-quebec-who-are-registered-under-the-general-gsthst-system/
- Revenue.ie, ESS and non-Union OSS: https://revenue.ie/en/vat/vat-on-services/electronic-services/vat-and-electronically-supplied-services/index.aspx and https://www.revenue.ie/en/tax-professionals/tdm/value-added-tax/part10-special-schemes/vat-ecommerce-rules/non-union-scheme-one-stop-shop-oss.pdf
- Vertex, EU 2019 changes: https://www.vertexinc.com/resources/resource-library/2019-eu-vat-changes-part-1-origin-taxation-less-evidence
- HMRC forum: https://community.hmrc.gov.uk/customerforums/vat/15f99cef-69c1-ee11-a81c-000d3a0d1900 and https://community.hmrc.gov.uk/customerforums/vat/2095f20b-d233-ef11-a81d-6045bd0b6b38
- Quaderno UK VAT: https://quaderno.io/guides/united-kingdom/vat/registration/
- TaxCloud nexus: https://taxcloud.com/blog/sales-tax-nexus-by-state/
- Beancount 2026 SaaS overview: https://beancount.io/blog/2026/05/14/sales-tax-saas-streaming-digital-goods-2026-true-object-test-economic-nexus-wayfair-state-by-state-compliance-guide

**Privacy and lawful access**
- PIPEDA full text: https://laws-lois.justice.gc.ca/eng/acts/P-8.6/FullText.html
- BC PIPA: https://www.bclaws.gov.bc.ca/civix/document/id/complete/statreg/03063_01
- OPC, PIPEDA in BC/AB: https://www.priv.gc.ca/en/privacy-topics/privacy-laws-in-canada/the-personal-information-protection-and-electronic-documents-act-pipeda/r_o_p/02_05_d_26/
- OPC breach guidance: https://www.priv.gc.ca/en/privacy-topics/business-privacy/breaches-and-safeguards/privacy-breaches-at-your-business/gd_pb_201810/
- OPC cross-border guidelines: https://www.priv.gc.ca/en/privacy-topics/personal-information-transferred-across-borders/gl_dab_090127/ and https://priv.gc.ca/en/opc-news/news-and-announcements/2019/an_190923
- Torys 2020: https://www.torys.com/en/our-latest-thinking/publications/2020/10/british-columbia-privacy-czar-recommends-reforms-to-privacy-legislation
- Gowling 2024 review: https://gowlingwlg.com/en/insights-resources/articles/2024/alberta-and-british-columbia-privacy-law-2024-year-in-review
- Gowling C-27 timeline: https://gowlingwlg.com/en/insights-resources/articles/2024/bill-c27-timeline-of-developments
- LEGISinfo C-36: https://www.parl.ca/legisinfo/en/bill/45-1/c-36
- ISED backgrounder: https://www.canada.ca/en/innovation-science-economic-development/news/2026/06/government-of-canada-introduces-legislation-to-protect-canadians-privacy-in-the-digital-age.html
- DLA Piper C-36: https://www.dlapiper.com/en/insights/publications/2026/06/canada-tables-bill-c36-the-protecting-privacy-and-consumer-data-act
- Osler C-36: https://www.osler.com/en/insights/reports/the-protecting-privacy-and-consumer-data-act-bill-c-36-key-obligations-and-enforcement-overview/
- LEGISinfo C-22: https://www.parl.ca/legisinfo/en/bill/45-1/c-22
- Fasken C-22: https://www.fasken.com/en/knowledge/2026/03/the-government-of-canada-introduces-bill-c22
- CBA on C-22: https://cba.org/our-impact/submissions/bill-c-22-lawful-access-act-2026/bill-c-22-lawful-access-act-2026
- Mondaq, production orders and virtual presence: https://mondaq.com/canada/trials-appeals-compensation/1391742/expanding-the-scope-of-production-orders-virtual-presence-brings-data-around-the-world-into-the-purview-of-canadian-law-enforcement
- OVHcloud production order: https://blog.ovhcloud.com/en/posts/ovhcloud-contests-canadian-production-order-charges/
- Geist, MLAT: https://www.michaelgeist.ca/tag/mlat/
- CBA on a CLOUD Act agreement: https://cba.org/Our-Work/Submissions-(1)/Submissions/2024/November/Cloud-Act-Agreement
- Telecommunications Act: https://laws-lois.justice.gc.ca/eng/acts/T-3.4/page-1.html

**CASL**
- CASL full text: https://laws-lois.justice.gc.ca/eng/acts/E-1.6/FullText.html
- CRTC 2018-415: https://crtc.gc.ca/eng/archive/2018/2018-415.htm
- Dentons: https://www.dwpv.com/en/Insights/Publications/2018/Whose-Liability-Is-It-Anyway
- Mondaq, intermediaries: https://www.mondaq.com/canada/telecoms-mobile-cable-communications/764348/digital-intermediaries-responsibility-for-unknown-casl-violations
- Osler, PRA suspension 2017: https://www.osler.com/en/insights/updates/canadian-government-suspends-casl-private-right-of/

**Market and storage**
- Provider pricing pages and community threads: see the local named copy in `docs/internal/private/competitors/` (gitignored).
- Backblaze B2: https://www.backblaze.com/cloud-storage/pricing
- OVH object storage (announcement): https://iteuropa.com/news/ovhcloud-launches-new-object-storage-solution
