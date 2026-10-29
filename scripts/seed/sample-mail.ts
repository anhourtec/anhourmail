// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Demo sample mail for the webmail (CLAUDE.md rule 50). The messages are built here as RFC 5322 text and placed
 * straight into one demo mailbox with JMAP `Email/import` — nothing is sent, so no mail leaves Stalwart and no
 * external address is ever contacted (rule 19). Senders on `.example` domains are fictional (RFC 2606).
 *
 * Idempotent: every message carries an `X-AnhourMail-Sample` header; if the mailbox already has one, the import
 * is skipped.
 */
import { randomBytes } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";

import type { JmapClient } from "@anhourmail/jmap-client";

type Addr = { name: string; email: string };
type Folder = "inbox" | "archive" | "sent" | "junk" | "receipts" | "receipts/home";
type Attachment = { name: string; type: string; content: Buffer };

type Sample = {
  key: string;
  folder: Folder;
  /** Days before now, plus the hour of day (local to the server). */
  ago: [days: number, hour: number, minute?: number];
  from: Addr;
  to: Addr[];
  cc?: Addr[];
  subject: string;
  text: string;
  html?: string;
  attachments?: Attachment[];
  unread?: boolean;
  flagged?: boolean;
  /** Key of the message this replies to (threads by In-Reply-To / References). */
  replyTo?: string;
  /** A ready-made body (Content-Type + encoded body) for the special shapes: markdown, calendar, rfc822, charsets. */
  mime?: { type: string; body: string; encoding?: string };
  /**
   * Arrived from outside and passed the sender's checks: carries the dev mail server's own `Received` plus
   * `Authentication-Results` pair on top, as real inbound mail does (the webmail trusts only that pair).
   */
  checked?: boolean;
};

const SAMPLE_HEADER = "X-AnhourMail-Sample";

/** A tiny, valid one-page PDF ("Spring garden plan"), built at run time so no binary lives in the repo. */
function tinyPdf(title: string): Buffer {
  const text = `BT /F1 18 Tf 72 720 Td (${title}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

export function sampleMessages(owner: Addr, domain: string): Sample[] {
  const sam: Addr = { name: "Sam Rivera", email: `member@${domain}` };
  const jordan: Addr = { name: "Jordan Lee", email: `users@${domain}` };
  const priya: Addr = { name: "Priya Shah", email: `domains@${domain}` };
  const club: Addr = { name: "Harbour Reading Club", email: "news@harbour-reading.example" };
  const trail: Addr = { name: "Coastal Trail Runners", email: "hello@coastal-trail.example" };
  const library: Addr = { name: "Westside Library", email: "notices@westside-library.example" };
  const market: Addr = { name: "Greenleaf Market", email: "orders@greenleaf-market.example" };
  const plumber: Addr = { name: "Northside Plumbing", email: "billing@northside-plumbing.example" };
  const piano: Addr = { name: "Maya Chen", email: "maya@piano-studio.example" };
  const assoc: Addr = { name: "Elm Street Neighbours", email: "board@elm-street.example" };
  const welcome: Addr = { name: "AnhourMail", email: "hello@anhourmail.test" };
  const spam: Addr = { name: "Prize Desk", email: "winner@prize-desk.example" };

  const newsletterHtml = `<!doctype html><html><head><meta charset="utf-8"><title>Harbour Reading Club</title>
<style>
  body { margin: 0; background: #f4f1ea; font-family: Georgia, serif; color: #2b2b2b; }
  .wrap { max-width: 600px; margin: 0 auto; background: #ffffff; }
  .hero { background-image: url("https://cdn.harbour-reading.example/img/hero-bg.jpg"); padding: 32px; }
  h1 { font-weight: normal; font-size: 28px; margin: 0 0 8px; }
  .pick { display: flex; gap: 16px; padding: 24px 32px; border-top: 1px solid #e6e1d6; }
  .btn { display: inline-block; background: #1f4e5f; color: #ffffff; padding: 10px 18px; border-radius: 6px; text-decoration: none; }
  .foot { font-size: 12px; color: #77706a; padding: 24px 32px; }
</style></head>
<body><div class="wrap">
  <div class="hero">
    <img src="https://cdn.harbour-reading.example/img/logo.png" width="120" height="40" alt="Harbour Reading Club">
    <h1>This month: stories set by the sea</h1>
    <p>Three new picks, a members' evening, and the swap shelf is back.</p>
  </div>
  <img src="https://cdn.harbour-reading.example/img/banner.jpg" srcset="https://cdn.harbour-reading.example/img/banner@2x.jpg 2x" width="600" height="220" alt="A stack of paperbacks on a windowsill">
  <div class="pick">
    <img src="https://cdn.harbour-reading.example/img/cover-1.jpg" width="96" height="144" alt="Cover: The Lighthouse Keeper's Year">
    <div><h2 style="font-weight:normal;margin:0 0 6px">The Lighthouse Keeper's Year</h2>
    <p>A quiet, funny novel about a keeper who writes one letter a day to a town that never answers.</p>
    <a class="btn" href="https://harbour-reading.example/picks/lighthouse">Read the first chapter</a></div>
  </div>
  <div class="pick">
    <img src="https://cdn.harbour-reading.example/img/cover-2.jpg" width="96" height="144" alt="Cover: Salt and Paper">
    <div><h2 style="font-weight:normal;margin:0 0 6px">Salt and Paper</h2>
    <p>Essays on boats, maps and the people who draw them. Short chapters, perfect for the ferry.</p></div>
  </div>
  <div class="pick"><div>
    <h2 style="font-weight:normal;margin:0 0 6px">Members' evening — Thursday at 7</h2>
    <p>Tea, a short reading and the swap shelf. Bring one book, take one home.</p>
  </div></div>
  <div class="foot">You get this because you joined the Harbour Reading Club.
    <a href="https://harbour-reading.example/unsubscribe">Unsubscribe</a>
    <img src="https://track.harbour-reading.example/open.gif?u=8f2a" width="1" height="1" alt="">
  </div>
</div></body></html>`;

  const welcomeHtml = `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="margin:0;font-family:system-ui,sans-serif;color:#0f141e">
<div style="max-width:560px;margin:0 auto;padding:32px 24px">
  <h1 style="font-weight:500;font-size:24px;margin:0 0 12px">Welcome to your new mailbox</h1>
  <p style="line-height:1.6">Your address <strong>${owner.email}</strong> is ready. A few things worth knowing:</p>
  <ul style="line-height:1.7;padding-left:20px">
    <li><strong>Remote images are blocked</strong> until you choose to load them, so senders can't see when you open their mail.</li>
    <li><strong>Masked aliases</strong> give every shop or newsletter its own address. Turn one off and the mail stops.</li>
    <li><strong>Mail apps</strong> use app passwords, never your main password.</li>
  </ul>
  <p style="line-height:1.6">Questions? Reply to this message and a person will answer.</p>
  <p style="line-height:1.6;color:#646e80;font-size:13px">— The AnhourMail team, Vancouver and Victoria</p>
</div></body></html>`;

  const tripHtml = `<p>Hi all,</p><p>Here's the plan for the cabin weekend:</p>
<table style="border-collapse:collapse" cellpadding="6" border="1">
<tr><th align="left">Day</th><th align="left">What</th></tr>
<tr><td>Friday</td><td>Leave at 4, pizza on the way</td></tr>
<tr><td>Saturday</td><td>Lake loop hike, then the market</td></tr>
<tr><td>Sunday</td><td>Pancakes, pack up by noon</td></tr>
</table><p>Sam</p>`;

  return [
    {
      key: "welcome",
      folder: "inbox",
      ago: [27, 9, 12],
      from: welcome,
      to: [owner],
      subject: "Welcome to your new mailbox",
      text: `Welcome to your new mailbox\n\nYour address ${owner.email} is ready.\n\n- Remote images are blocked until you choose to load them.\n- Masked aliases give every shop or newsletter its own address.\n- Mail apps use app passwords, never your main password.\n\nThe AnhourMail team`,
      html: welcomeHtml,
    },
    // Thread: weekend at the cabin (3 messages, one of them ours in Sent)
    {
      key: "cabin-1",
      folder: "inbox",
      ago: [6, 18, 40],
      from: sam,
      to: [owner],
      cc: [jordan],
      subject: "Weekend at the cabin",
      text: "Hi all,\n\nHere's the plan for the cabin weekend:\n\nFriday — leave at 4, pizza on the way\nSaturday — lake loop hike, then the market\nSunday — pancakes, pack up by noon\n\nSam",
      html: tripHtml,
    },
    {
      key: "cabin-2",
      folder: "sent",
      ago: [6, 20, 5],
      from: owner,
      to: [sam],
      cc: [jordan],
      subject: "Re: Weekend at the cabin",
      text: "Sounds great. I'll bring the camp stove and the good coffee. Can someone grab firewood on the way?\n\nAlex",
      replyTo: "cabin-1",
    },
    {
      key: "cabin-3",
      folder: "inbox",
      ago: [1, 8, 15],
      from: jordan,
      to: [owner, sam],
      subject: "Re: Weekend at the cabin",
      text: "Firewood is on me — I'll stop at the stand by the bridge. Leaving from my place at 3:45 if anyone wants a ride.\n\nJordan",
      replyTo: "cabin-2",
      unread: true,
    },
    {
      key: "newsletter",
      folder: "inbox",
      ago: [0, 7, 30],
      checked: true,
      from: club,
      to: [owner],
      subject: "This month: stories set by the sea",
      text: "This month: stories set by the sea.\n\nThree new picks, a members' evening, and the swap shelf is back.\n\nRead online: https://harbour-reading.example/picks",
      html: newsletterHtml,
      unread: true,
    },
    {
      key: "garden",
      folder: "inbox",
      ago: [2, 14, 2],
      from: priya,
      to: [owner],
      subject: "Garden plan for spring",
      text: "Hi Alex,\n\nAttached is the planting plan we talked about, plus the seed list as a spreadsheet. The raised beds go in first week of April if the frost holds off.\n\nPriya",
      attachments: [
        { name: "garden-plan.pdf", type: "application/pdf", content: tinyPdf("Spring garden plan") },
        {
          name: "seed-list.csv",
          type: "text/csv",
          content: Buffer.from(
            "plant,bed,sow by\nsnap peas,north,March 20\nlettuce mix,east,April 1\ncarrots,south,April 10\nbasil,pots,May 1\n",
          ),
        },
      ],
      flagged: true,
    },
    // Thread: dinner (2 messages)
    {
      key: "dinner-1",
      folder: "inbox",
      ago: [3, 12, 20],
      from: sam,
      to: [owner],
      subject: "Dinner on Friday?",
      text: "Want to try the new noodle place on Friday? I can book for 7.",
    },
    {
      key: "dinner-2",
      folder: "sent",
      ago: [3, 13, 0],
      from: owner,
      to: [sam],
      subject: "Re: Dinner on Friday?",
      text: "Yes please. 7 works — I'll meet you there.",
      replyTo: "dinner-1",
    },
    {
      key: "holds",
      folder: "inbox",
      ago: [1, 16, 45],
      from: library,
      to: [owner],
      subject: "Your holds are ready for pickup",
      text: "Hello,\n\n2 items are waiting for you at the Westside branch:\n\n- The Lighthouse Keeper's Year\n- A Field Guide to Tide Pools\n\nThey will be held until next Saturday.\n\nWestside Library",
      flagged: true,
      unread: true,
    },
    {
      key: "trail",
      folder: "inbox",
      ago: [4, 19, 10],
      from: trail,
      to: [owner],
      subject: "Sunday route: the bluffs and back",
      text: "Morning runners,\n\nThis Sunday we're doing the bluffs loop — 9 km, mostly gravel, one steep bit after the bridge. Meet at the trailhead at 8:00. Coffee after at the usual spot.\n\nSee you there",
    },
    {
      key: "piano",
      folder: "inbox",
      ago: [5, 10, 0],
      from: piano,
      to: [owner],
      subject: "Lesson moved to Thursday",
      text: "Hi Alex,\n\nSmall change this week: can we move Tuesday's lesson to Thursday at 4:30? Same room.\n\nThanks,\nMaya",
      unread: true,
    },
    {
      key: "assoc",
      folder: "inbox",
      ago: [8, 20, 30],
      from: assoc,
      to: [owner],
      subject: "Notes from the neighbourhood meeting",
      text: "Thanks to everyone who came out on Tuesday.\n\n1. The street tree planting is confirmed for the 14th.\n2. Block party: we need two more volunteers for set-up.\n3. Next meeting: first Tuesday of next month, community hall.\n\nMinutes are attached to the noticeboard by the library.",
    },
    {
      key: "recipe",
      folder: "inbox",
      ago: [10, 21, 0],
      from: jordan,
      to: [owner],
      subject: "That lemon cake recipe",
      text: "As promised!\n\nLemon olive oil cake\n- 3 eggs\n- 200 g sugar\n- zest of 2 lemons\n- 120 ml olive oil\n- 180 ml yogurt\n- 200 g flour, 2 tsp baking powder, pinch of salt\n\nWhisk eggs, sugar and zest until pale. Stir in oil and yogurt, fold in the dry bits. 45 minutes at 175°C. Let it cool before you glaze it (I never manage to wait).",
    },
    {
      key: "swim",
      folder: "inbox",
      ago: [12, 9, 30],
      from: priya,
      to: [owner, sam],
      subject: "Swim lessons sign-up opens Monday",
      text: "Heads up: sign-up for the spring swim lessons opens Monday at 9. The Saturday morning slots go fast.",
    },
    {
      key: "photos",
      folder: "inbox",
      ago: [14, 17, 0],
      from: sam,
      to: [owner],
      subject: "Photos from the lake",
      text: "Uploaded the photos from the lake to the shared album. My favourite is the one with the heron.",
    },
    // Receipts (custom folder with a nested child)
    {
      key: "order",
      folder: "receipts",
      ago: [9, 11, 0],
      from: market,
      to: [owner],
      subject: "Order 48213 has shipped",
      text: "Your order 48213 has shipped and should arrive in 2–3 days.\n\n1 × Ceramic teapot\n2 × Loose-leaf green tea\n\nTotal: $46.50",
    },
    {
      key: "plumber",
      folder: "receipts/home",
      ago: [15, 15, 0],
      from: plumber,
      to: [owner],
      subject: "Invoice 2026-0412",
      text: "Thank you for choosing Northside Plumbing.\n\nInvoice 2026-0412 — kitchen tap replacement — $185.00\nPaid in full. Keep this email for your records.",
    },
    // Archive: older, read
    {
      key: "arch-1",
      folder: "archive",
      ago: [22, 10, 0],
      from: assoc,
      to: [owner],
      subject: "Street tree planting: volunteers wanted",
      text: "We're looking for ten volunteers for the street tree planting. Gloves and shovels provided.",
    },
    {
      key: "arch-2",
      folder: "archive",
      ago: [24, 13, 0],
      from: library,
      to: [owner],
      subject: "Reminder: 1 item due soon",
      text: "A Field Guide to Tide Pools is due in 3 days. You can renew it online or at the desk.",
    },
    {
      key: "arch-3",
      folder: "archive",
      ago: [26, 18, 0],
      from: trail,
      to: [owner],
      subject: "Welcome to Coastal Trail Runners",
      text: "Glad to have you. We run Sundays at 8 and Wednesdays at 6:30 — all paces welcome.",
    },
    {
      key: "arch-4",
      folder: "archive",
      ago: [20, 8, 0],
      from: jordan,
      to: [owner],
      subject: "Borrowing the ladder",
      text: "Could I borrow the tall ladder this weekend? I'll bring it back Sunday.",
    },
    // Sent: our own messages
    {
      key: "sent-1",
      folder: "sent",
      ago: [2, 9, 0],
      from: owner,
      to: [priya],
      subject: "Re: Garden plan for spring",
      text: "This is great, thanks! Let's add a bed for strawberries.",
      replyTo: "garden",
    },
    {
      key: "sent-2",
      folder: "sent",
      ago: [5, 11, 0],
      from: owner,
      to: [piano],
      subject: "Re: Lesson moved to Thursday",
      text: "Thursday at 4:30 works. See you then.",
      replyTo: "piano",
    },
    {
      key: "sent-3",
      folder: "sent",
      ago: [11, 19, 0],
      from: owner,
      to: [assoc],
      subject: "Block party set-up",
      text: "Count me in for set-up. I can bring two folding tables.",
    },
    // Junk
    {
      key: "spam",
      folder: "junk",
      ago: [1, 3, 0],
      from: spam,
      to: [owner],
      subject: "Congratulations!!! You have been selected",
      text: "You have been selected to receive a prize. Reply with your bank details to claim it today.",
      unread: true,
    },
    ...richSamples(owner, domain, { sam, jordan, priya, club }),
  ];
}

/** A small gradient PNG built at run time (no binary in the repo). */
function tinyPng(w = 48, h = 32): Buffer {
  const rows: Buffer[] = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3);
    for (let x = 0; x < w; x++) {
      row[1 + x * 3] = 40 + Math.round((x / w) * 120);
      row[2 + x * 3] = 110 + Math.round((y / h) * 100);
      row[3 + x * 3] = 200;
    }
    rows.push(row);
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** One message per body shape the reader handles (plain + quotes + signature, markdown, invite, forward, …). */
function richSamples(owner: Addr, domain: string, p: Record<"sam" | "jordan" | "priya" | "club", Addr>): Sample[] {
  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Elm Street Neighbours//Events//EN",
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    `UID:block-party-2026@${domain}`,
    "DTSTAMP:20261020T120000Z",
    "DTSTART:20261031T180000Z",
    "DTEND:20261031T210000Z",
    "SUMMARY:Elm Street block party",
    "LOCATION:Community hall\\, 12 Elm Street",
    `ORGANIZER;CN=Priya Shah:mailto:${p.priya.email}`,
    "DESCRIPTION:Bring a dish to share. Tables and chairs are provided.\\nMusic from 7.",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
  const invite = multipart("mixed", [
    part(
      "text/plain; charset=utf-8",
      Buffer.from("You're invited to the Elm Street block party. Details below.\n\nPriya"),
    ),
    part('text/calendar; charset=utf-8; method=REQUEST; name="invite.ics"', Buffer.from(ics), [
      'Content-Disposition: attachment; filename="invite.ics"',
    ]),
  ]);

  const innerDate = new Date(Date.now() - 9 * 86_400_000).toUTCString().replace("GMT", "+0000");
  const inner = [
    `From: "Harbour Reading Club" <${p.club.email}>`,
    `To: "Sam Rivera" <${p.sam.email}>`,
    "Subject: Members' evening moved to Friday",
    `Date: ${innerDate}`,
    `Message-ID: <inner-evening@harbour-reading.example>`,
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    b64(
      Buffer.from(
        '<h2 style="font-weight:normal">Members\' evening moves to Friday</h2><p>Same time, same room. The swap shelf comes too.</p><p><img src="https://cdn.harbour-reading.example/img/shelf.jpg" width="400" height="200" alt="The swap shelf"></p>',
      ),
    ),
  ].join("\r\n");
  const forwarded = multipart("mixed", [
    part("text/plain; charset=utf-8", Buffer.from("Forwarding this from Sam — looks like Friday now.\n\nJordan")),
    [
      'Content-Type: message/rfc822; name="Members evening moved to Friday.eml"',
      'Content-Disposition: attachment; filename="Members evening moved to Friday.eml"',
      "Content-Transfer-Encoding: 7bit",
      "",
      inner,
    ].join("\r\n"),
  ]);

  const flowed = [
    "Sounds good to me. I'll bring the folding chairs and a big salad, and I can ",
    "pick up ice on the way if someone reminds me on Saturday morning.",
    "",
    "The route is on https://coastal-trail.example/routes/bluffs and questions go ",
    "to hello@coastal-trail.example.",
    "",
    `On Mon, Oct 19, 2026 at 9:14 AM Jordan Lee <${p.jordan.email}> wrote:`,
    "> Are we still doing the potluck after the run? I can bring bread and the ",
    "> good cheese.",
    ">",
    ">> Who's bringing chairs? We need at least ten.",
    "",
    "-- ",
    "Sam Rivera",
    "Coastal Trail Runners · Sundays at 8",
    "",
  ].join("\r\n");

  const markdown = [
    "# Cabin weekend checklist",
    "",
    "Here's the **final list**. Tick things off in the group chat when they're packed.",
    "",
    "## Food",
    "",
    "- Pancake mix and *real* maple syrup",
    "- Coffee (the good one)",
    "- Snacks for the hike",
    "",
    "## Gear",
    "",
    "1. Camp stove and fuel",
    "2. Headlamps",
    "3. First-aid kit",
    "",
    "> Leave by 4 on Friday so we beat the ferry traffic.",
    "",
    "Wood stand hours: `8:00–18:00`. Map: [bluffs loop](https://coastal-trail.example/routes/bluffs).",
    "",
    "```",
    "Cabin code: 4471",
    "Wi-Fi: lakeside / ask Jordan",
    "```",
    "",
    "<script>alert('markdown can carry HTML; it must never run')</script>",
    "",
  ].join("\n");

  const latin1 = Buffer.from(
    "Bonjour Alex,\n\nLe café du marché ouvre à 7 h. Crème brûlée à la carte, et la pâtisserie de Zoë est déjà célèbre.\nÀ samedi !\n\nAnaïs",
    "latin1",
  );

  const paragraph =
    "This is a deliberately long message to show how the webmail handles very large bodies. It repeats so it is " +
    "large enough to be cut short in the reader, with a button to see all of it.\n\n";
  const long = paragraph.repeat(Math.ceil(1_100_000 / paragraph.length));

  return [
    {
      key: "plain-quote",
      folder: "inbox",
      ago: [0, 9, 5],
      from: p.sam,
      to: [owner, p.jordan],
      subject: "Re: Potluck after the run",
      text: flowed,
      mime: { type: "text/plain; charset=utf-8; format=flowed", body: b64(Buffer.from(flowed)), encoding: "base64" },
      unread: true,
    },
    {
      key: "markdown",
      folder: "inbox",
      ago: [2, 8, 30],
      from: p.jordan,
      to: [owner],
      subject: "Cabin weekend checklist",
      text: markdown,
      mime: { type: "text/markdown; charset=utf-8", body: b64(Buffer.from(markdown)), encoding: "base64" },
    },
    {
      key: "invite",
      folder: "inbox",
      ago: [1, 11, 20],
      from: p.priya,
      to: [owner],
      subject: "Invitation: Elm Street block party",
      text: "You're invited to the Elm Street block party.",
      mime: invite,
    },
    {
      key: "forwarded",
      folder: "inbox",
      ago: [3, 16, 40],
      from: p.jordan,
      to: [owner],
      subject: "Fwd: Members' evening moved to Friday",
      text: "Forwarding this from Sam.",
      mime: forwarded,
    },
    {
      key: "photo",
      folder: "inbox",
      ago: [4, 13, 10],
      from: p.sam,
      to: [owner],
      subject: "Sunset from the dock",
      text: "Took this last night from the dock. The colours were unreal.\n\nSam",
      attachments: [{ name: "dock-sunset.png", type: "image/png", content: tinyPng() }],
    },
    {
      key: "latin1",
      folder: "inbox",
      ago: [5, 7, 45],
      from: { name: "Anaïs Martin", email: "anais@marche-local.example" },
      to: [owner],
      subject: "Le marché de samedi",
      text: "",
      mime: { type: "text/plain; charset=iso-8859-1", body: b64(latin1), encoding: "base64" },
    },
    {
      key: "long",
      folder: "archive",
      ago: [16, 9, 0],
      from: p.club,
      to: [owner],
      subject: "The complete reading list (very long)",
      text: long,
    },
  ];
}

// ---- MIME ---------------------------------------------------------------------------------------------------

const fmt = (a: Addr) => `"${a.name.replace(/"/g, "")}" <${a.email}>`;
const b64 = (buf: Buffer) => (buf.toString("base64").match(/.{1,76}/g) ?? []).join("\r\n");
const encodeWord = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString("base64")}?=`);
const boundary = () => `=_am_${randomBytes(9).toString("hex")}`;

function part(type: string, body: Buffer, extra: string[] = []): string {
  return [`Content-Type: ${type}`, "Content-Transfer-Encoding: base64", ...extra, "", b64(body)].join("\r\n");
}

function multipart(kind: string, parts: string[]): { type: string; body: string } {
  const b = boundary();
  return {
    type: `multipart/${kind}; boundary="${b}"`,
    body: `${parts.map((p) => `--${b}\r\n${p}`).join("\r\n")}\r\n--${b}--`,
  };
}

export function toRfc822(s: Sample, domain: string, now: number): { raw: string; receivedAt: string } {
  const [days, hour, minute = 0] = s.ago;
  const d = new Date(now - days * 86_400_000);
  d.setHours(hour, minute, 0, 0);
  if (d.getTime() > now) d.setTime(now - 60_000 * (days + 5));
  const id = (key: string) => `<sample-${key}@${domain}>`;
  const textPart = part("text/plain; charset=utf-8", Buffer.from(s.text));
  let content: { type: string; body: string } = s.mime
    ? { type: s.mime.type, body: s.mime.body }
    : s.html
      ? multipart("alternative", [textPart, part("text/html; charset=utf-8", Buffer.from(s.html))])
      : { type: "text/plain; charset=utf-8", body: b64(Buffer.from(s.text)) };
  const plainHeaders = s.mime
    ? s.mime.encoding
      ? [`Content-Transfer-Encoding: ${s.mime.encoding}`]
      : []
    : s.html
      ? []
      : ["Content-Transfer-Encoding: base64"];
  if (s.attachments?.length && !s.mime) {
    const inner = s.html ? `Content-Type: ${content.type}\r\n\r\n${content.body}` : textPart;
    content = multipart("mixed", [
      inner,
      ...s.attachments.map((a) =>
        part(`${a.type}; name="${a.name}"`, a.content, [`Content-Disposition: attachment; filename="${a.name}"`]),
      ),
    ]);
    plainHeaders.length = 0;
  }
  const fromDomain = s.from.email.slice(s.from.email.lastIndexOf("@") + 1);
  const date = d.toUTCString().replace("GMT", "+0000");
  const headers = [
    ...(s.checked
      ? [
          `Received: from mx.${fromDomain} by mail.dev.test with ESMTPS; ${date}`,
          `Authentication-Results: mail.dev.test; spf=pass smtp.mailfrom=${s.from.email}; ` +
            `dkim=pass header.d=${fromDomain}; dmarc=pass header.from=${fromDomain}`,
        ]
      : []),
    `From: ${fmt(s.from)}`,
    `To: ${s.to.map(fmt).join(", ")}`,
    ...(s.cc?.length ? [`Cc: ${s.cc.map(fmt).join(", ")}`] : []),
    `Subject: ${encodeWord(s.subject)}`,
    `Date: ${date}`,
    `Message-ID: ${id(s.key)}`,
    ...(s.replyTo ? [`In-Reply-To: ${id(s.replyTo)}`, `References: ${id(s.replyTo)}`] : []),
    `${SAMPLE_HEADER}: 1`,
    "MIME-Version: 1.0",
    `Content-Type: ${content.type}`,
    ...plainHeaders,
  ];
  return { raw: `${headers.join("\r\n")}\r\n\r\n${content.body}\r\n`, receivedAt: d.toISOString() };
}

// ---- import -------------------------------------------------------------------------------------------------

/** Stalwart's `maxObjectsInGet` default: one `Email/get` may name at most this many ids. */
const PAGE = 500;

/** Reads `properties` of every message in the mailbox, newest first, a page at a time. */
async function everyMessage(
  jmap: JmapClient,
  accountId: string,
  properties: string[],
): Promise<Record<string, unknown>[]> {
  const all: Record<string, unknown>[] = [];
  for (let position = 0; ; position += PAGE) {
    const res = await jmap.request([
      [
        "Email/query",
        { accountId, sort: [{ property: "receivedAt", isAscending: false }], position, limit: PAGE },
        "q",
      ],
      ["Email/get", { accountId, "#ids": { resultOf: "q", name: "Email/query", path: "/ids" }, properties }, "g"],
    ]);
    const page = (res.get("g")?.list ?? []) as Record<string, unknown>[];
    all.push(...page);
    if (page.length < PAGE) return all;
  }
}

/**
 * Ids of messages that carry the sample header. Stalwart v0.16 doesn't answer `Email/query` header filters for
 * custom headers, so this reads the header of every message instead.
 */
export async function sampleIds(jmap: JmapClient, accountId: string): Promise<string[]> {
  const list = await everyMessage(jmap, accountId, [`header:${SAMPLE_HEADER}:asText`]);
  return list.filter((e) => typeof e[`header:${SAMPLE_HEADER}:asText`] === "string").map((e) => String(e.id));
}

/** Keys of the samples already in the mailbox (from their `<sample-KEY@domain>` Message-IDs). */
export async function sampleKeys(jmap: JmapClient, accountId: string): Promise<Set<string>> {
  const keys = new Set<string>();
  for (const e of (await everyMessage(jmap, accountId, ["messageId"])) as { messageId?: string[] | null }[]) {
    const m = /^sample-([a-z0-9-]+)@/.exec(e.messageId?.[0] ?? "");
    if (m?.[1]) keys.add(m[1]);
  }
  return keys;
}

type Box = { id: string; name: string; role: string | null; parentId: string | null };

/**
 * Imports the samples into `owner`'s mailbox (signing in as the owner, never as an admin). Creates Archive (role
 * `archive`; the dev plan's default folders and backfill normally have already) and a nested Receipts › Home folder
 * when missing.
 * Imports only samples that aren't there yet (so new samples reach existing dev mailboxes). Returns how many.
 */
export async function importSampleMail(
  jmap: JmapClient,
  owner: Addr,
  domain: string,
  /** Creates the sample folders: customer accounts can't create folders over JMAP themselves (no sharing). */
  folders: JmapClient = jmap,
): Promise<number> {
  const accountId = await jmap.accountId();
  const present = await sampleKeys(jmap, accountId);
  const missing = sampleMessages(owner, domain).filter((x) => !present.has(x.key));
  if (missing.length === 0) return 0;

  const boxes = async () =>
    ((
      await jmap.request([["Mailbox/get", { accountId, ids: null, properties: ["name", "role", "parentId"] }, "m"]])
    ).get("m")?.list ?? []) as Box[];
  let list = await boxes();
  const create: Record<string, Record<string, unknown>> = {};
  if (!list.some((b) => b.role === "archive")) create.archive = { name: "Archive", role: "archive" };
  const receipts = list.find((b) => b.name === "Receipts" && b.parentId === null);
  if (!receipts) {
    create.receipts = { name: "Receipts" };
    create.home = { name: "Home", parentId: "#receipts" };
  } else if (!list.some((b) => b.name === "Home" && b.parentId === receipts.id)) {
    create.home = { name: "Home", parentId: receipts.id };
  }
  if (Object.keys(create).length > 0) {
    await folders.request([["Mailbox/set", { accountId, create }, "c"]]);
    list = await boxes();
  }
  const receiptsId = list.find((b) => b.name === "Receipts" && b.parentId === null)?.id;
  const folderId: Record<Folder, string | undefined> = {
    inbox: list.find((b) => b.role === "inbox")?.id,
    archive: list.find((b) => b.role === "archive")?.id,
    sent: list.find((b) => b.role === "sent")?.id,
    junk: list.find((b) => b.role === "junk")?.id,
    receipts: receiptsId,
    "receipts/home": list.find((b) => b.name === "Home" && b.parentId === receiptsId)?.id,
  };

  const now = Date.now();
  const samples = missing;
  const answered = new Set(samples.filter((s) => s.folder === "sent" && s.replyTo).map((s) => s.replyTo));
  const emails: Record<string, Record<string, unknown>> = {};
  for (const s of samples) {
    const mailbox = folderId[s.folder];
    if (!mailbox) throw new Error(`sample mail: no ${s.folder} folder`);
    const { raw, receivedAt } = toRfc822(s, domain, now);
    const blobId = await jmap.upload(raw, "message/rfc822");
    const keywords: Record<string, boolean> = {};
    if (!s.unread) keywords.$seen = true;
    if (s.flagged) keywords.$flagged = true;
    if (answered.has(s.key)) keywords.$answered = true;
    emails[s.key] = { blobId, mailboxIds: { [mailbox]: true }, keywords, receivedAt };
  }
  if (Object.keys(emails).length === 0) return 0;
  const res = await jmap.request([["Email/import", { accountId, emails }, "i"]]);
  const notCreated = res.get("i")?.notCreated as Record<string, unknown> | undefined;
  if (notCreated && Object.keys(notCreated).length > 0) {
    throw new Error(`sample mail: ${Object.keys(notCreated).length} messages not imported`);
  }
  return Object.keys(emails).length;
}
