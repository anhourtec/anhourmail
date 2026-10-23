// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { createMailer, mailTransportOptions, memoryMailer, sendMailOptions } from ".";

describe("mailTransportOptions", () => {
  it("parses the dev and production shapes with logging always off", () => {
    expect(mailTransportOptions("smtp://127.0.0.1:43125")).toEqual({
      host: "127.0.0.1",
      port: 43125,
      secure: false,
      logger: false,
      debug: false,
    });
    expect(
      mailTransportOptions(
        "smtps://no-reply%40example.org:p%40ss%2Fword@stalwart:465/?tls.servername=smtp.example.org",
      ),
    ).toEqual({
      host: "stalwart",
      port: 465,
      secure: true,
      logger: false,
      debug: false,
      auth: { user: "no-reply@example.org", pass: "p@ss/word" },
      tls: { servername: "smtp.example.org" },
    });
    expect(mailTransportOptions("smtp://mail.test?requireTLS=true&tls.rejectUnauthorized=false")).toMatchObject({
      port: 587,
      requireTLS: true,
      tls: { rejectUnauthorized: false },
    });
  });

  it("refuses ?logger=true&debug=true instead of writing SMTP transcripts to stdout", () => {
    expect(() => mailTransportOptions("smtp://127.0.0.1:43125/?logger=true&debug=true")).toThrow(
      /query option "logger" is not supported/,
    );
    expect(() => mailTransportOptions("smtp://127.0.0.1:43125/?debug=true")).toThrow(/"debug"/);
    expect(() => createMailer({ url: "smtp://h/?logger=true", from: "x@example.org" })).toThrow(/logger/);
  });

  it("refuses other schemes and bad values without echoing the URL (it holds the password)", () => {
    for (const bad of ["http://user:hunter2@h", "not a url hunter2", "smtp://user:hunter2@h/?secure=yes"]) {
      let message = "";
      try {
        mailTransportOptions(bad);
      } catch (err) {
        message = err instanceof Error ? err.message : "";
      }
      expect(message).toMatch(/^MAIL_TRANSPORT_URL/);
      expect(message).not.toContain("hunter2");
    }
  });
});

describe("sendMailOptions", () => {
  const message = { to: "kim@example.test", subject: "S", text: "T", html: "<p>H</p>" };

  it("passes a message without attachments through as is, with the sender", () => {
    expect(sendMailOptions("AnhourMail <no-reply@example.test>", message)).toEqual({
      from: "AnhourMail <no-reply@example.test>",
      ...message,
    });
    expect(sendMailOptions("f@example.test", { ...message, attachments: [] })).not.toHaveProperty("attachments");
  });

  it("hands inline images to nodemailer as base64, inline, with their content id", () => {
    const out = sendMailOptions("f@example.test", {
      ...message,
      attachments: [{ filename: "logo.png", contentType: "image/png", content: "iVBORw0K", cid: "logo@x" }],
    });
    expect(out.attachments).toEqual([
      {
        filename: "logo.png",
        contentType: "image/png",
        content: "iVBORw0K",
        encoding: "base64",
        cid: "logo@x",
        contentDisposition: "inline",
      },
    ]);
  });

  it("the memory mailer keeps attachments with the message", async () => {
    const m = memoryMailer();
    const attachments = [{ filename: "a.png", contentType: "image/png", content: "AA==", cid: "a@x" }];
    await m.send({ ...message, attachments });
    expect(m.sent[0]?.attachments).toEqual(attachments);
  });
});
