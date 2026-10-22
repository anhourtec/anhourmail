// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Demo contacts for the webmail (local dev only): a dozen fictional people in the mailbox's own address book and a
 * couple in "Other contacts" (as if saved automatically when emailed). Stored in Stalwart over JMAP Contacts, like
 * the app does; never in Postgres. Idempotent: a contact whose address is already in any book is skipped.
 * All addresses use the reserved `.example` domain.
 */
import type { JmapClient } from "@anhourmail/jmap-client";

const USING = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:contacts"];
const OTHER = "Other contacts";
const AUTO_SAVE_ON = "People you email are saved here automatically.";

type Seed = {
  given: string;
  surname: string;
  email: string;
  phone?: string;
  org?: string;
  note?: string;
  birthday?: [month: number, day: number, year?: number];
  labels?: string[];
};

const MINE: Seed[] = [
  {
    given: "Maya",
    surname: "Chen",
    email: "maya@piano-studio.example",
    phone: "+1 250 555 0142",
    org: "Chen Piano Studio",
    labels: ["kids"],
  },
  {
    given: "Anaïs",
    surname: "Martin",
    email: "anais@marche-local.example",
    org: "Marché local",
    labels: ["neighbours"],
  },
  {
    given: "Jordan",
    surname: "Lee",
    email: "jordan.lee@coastal-trail.example",
    phone: "+1 604 555 0199",
    org: "Coastal Trail Runners",
    birthday: [7, 4, 1990],
    labels: ["friends"],
  },
  {
    given: "Priya",
    surname: "Natarajan",
    email: "priya@natarajan-family.example",
    phone: "+1 250 555 0117",
    birthday: [3, 15],
    labels: ["family"],
    note: "Prefers texts after 6 pm.",
  },
  {
    given: "Sam",
    surname: "Rivera",
    email: "sam.rivera@rivera-home.example",
    phone: "+1 250 555 0108",
    labels: ["family"],
  },
  {
    given: "Elena",
    surname: "Petrova",
    email: "elena@harbour-reading.example",
    org: "Harbour Reading Club",
    labels: ["book club"],
  },
  {
    given: "Tomás",
    surname: "García",
    email: "tomas@garcia-builds.example",
    phone: "+1 778 555 0163",
    org: "García Builds",
    note: "Quoted the deck repair in May.",
  },
  { given: "Hana", surname: "Sato", email: "hana.sato@westside-library.example", org: "Westside Library" },
  {
    given: "Oliver",
    surname: "Brooks",
    email: "oliver@brooks-dental.example",
    phone: "+1 250 555 0190",
    org: "Brooks Dental",
  },
  { given: "Grace", surname: "Okafor", email: "grace@okafor.example", birthday: [11, 2], labels: ["friends"] },
  {
    given: "Liam",
    surname: "Walsh",
    email: "liam.walsh@elm-street.example",
    org: "Elm Street Neighbours",
    labels: ["neighbours"],
  },
  {
    given: "Zoe",
    surname: "Kim",
    email: "zoe.kim@school-pta.example",
    phone: "+1 250 555 0124",
    org: "Parent council",
    labels: ["kids"],
  },
];

const OTHERS: Seed[] = [
  { given: "Riley", surname: "Morgan", email: "riley.morgan@greenleaf-market.example" },
  { given: "", surname: "", email: "front-desk@northside-plumbing.example" },
];

function card(s: Seed, bookId: string): Record<string, unknown> {
  const components = [
    ...(s.given ? [{ kind: "given", value: s.given }] : []),
    ...(s.surname ? [{ kind: "surname", value: s.surname }] : []),
  ];
  const full = [s.given, s.surname].filter(Boolean).join(" ");
  return {
    "@type": "Card",
    version: "1.0",
    kind: "individual",
    addressBookIds: { [bookId]: true },
    name: { ...(full ? { full } : {}), ...(components.length > 0 ? { components, isOrdered: true } : {}) },
    emails: { e1: { address: s.email } },
    ...(s.phone ? { phones: { p1: { number: s.phone, features: { mobile: true } } } } : {}),
    ...(s.org ? { organizations: { o1: { name: s.org } } } : {}),
    ...(s.note ? { notes: { n1: { note: s.note } } } : {}),
    ...(s.birthday
      ? {
          anniversaries: {
            b1: {
              kind: "birth",
              date: {
                "@type": "PartialDate",
                ...(s.birthday[2] ? { year: s.birthday[2] } : {}),
                month: s.birthday[0],
                day: s.birthday[1],
              },
            },
          },
        }
      : {}),
    ...(s.labels ? { keywords: Object.fromEntries(s.labels.map((l) => [l, true])) } : {}),
  };
}

/** Adds the demo contacts that aren't there yet; returns how many were created. */
export async function importSampleContacts(jmap: JmapClient): Promise<number> {
  const accountId = await jmap.accountId();
  const books = (await jmap.request([["AddressBook/get", { accountId, ids: null }, "b"]], USING)).get("b")?.list as
    { id: string; name: string; isDefault?: boolean }[] | undefined;
  const mine = books?.find((b) => b.isDefault && b.name !== OTHER) ?? books?.find((b) => b.name !== OTHER);
  if (!mine) return 0;
  let otherId = books?.find((b) => b.name === OTHER)?.id;
  if (!otherId) {
    const r = await jmap.request(
      [["AddressBook/set", { accountId, create: { o: { name: OTHER, description: AUTO_SAVE_ON } } }, "s"]],
      USING,
    );
    otherId = (r.get("s")?.created as Record<string, { id: string }> | undefined)?.o?.id;
    if (!otherId) return 0;
  }
  const all = [...MINE.map((s) => ({ s, book: mine.id })), ...OTHERS.map((s) => ({ s, book: otherId }))];
  // Compare against every card's addresses (the `email` query filter uses the search index, which lags behind
  // fresh writes).
  const existing = (
    await jmap.request(
      [
        ["ContactCard/query", { accountId, limit: 5000 }, "q"],
        [
          "ContactCard/get",
          { accountId, "#ids": { resultOf: "q", name: "ContactCard/query", path: "/ids" }, properties: ["emails"] },
          "g",
        ],
      ],
      USING,
    )
  ).get("g")?.list as { emails?: Record<string, { address?: string }> }[] | undefined;
  const known = new Set(
    (existing ?? []).flatMap((c) => Object.values(c.emails ?? {}).map((e) => (e.address ?? "").toLowerCase())),
  );
  const missing = all.filter(({ s }) => !known.has(s.email.toLowerCase()));
  if (missing.length === 0) return 0;
  const r = await jmap.request(
    [
      [
        "ContactCard/set",
        { accountId, create: Object.fromEntries(missing.map(({ s, book }, i) => [`c${String(i)}`, card(s, book)])) },
        "s",
      ],
    ],
    USING,
  );
  return Object.keys((r.get("s")?.created as Record<string, unknown> | undefined) ?? {}).length;
}
