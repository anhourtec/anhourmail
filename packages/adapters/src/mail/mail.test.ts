// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { createMailer, mailTransportOptions } from ".";

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
