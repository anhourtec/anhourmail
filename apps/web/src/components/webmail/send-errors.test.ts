// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { SUPPORT_EMAIL } from "@anhourmail/shared/platform";

import { RefusedError, SignedOutError, UnavailableError } from "./mail-client";
import { domainsOf, outsideRecipients, sendProblem } from "./send-errors";

const HELD =
  "New accounts can send to addresses hosted on AnhourMail for now. Sending elsewhere opens automatically once your account is established.";

describe("outside recipients, worked out from the draft", () => {
  it("lists recipients on domains the app doesn't know we host, once each, lowercase, in order", () => {
    expect(
      outsideRecipients(
        ["Sam@Example.com", "me@dev.test", "jo@example.org", "sam@example.com", "pat@family.test", ""],
        ["dev.test", "FAMILY.test"],
      ),
    ).toEqual(["sam@example.com", "jo@example.org"]);
  });

  it("uses the last @ for the domain and ignores blank hosted entries", () => {
    expect(outsideRecipients(['"a@b"@dev.test', "x@other.test"], ["dev.test", " "])).toEqual(["x@other.test"]);
  });

  it("domainsOf takes each address's domain", () => {
    expect(domainsOf(["me@Dev.Test", "desk@team.test"])).toEqual(["dev.test", "team.test"]);
  });
});

describe("the composer's message for a refused send (ADR-0034 §5)", () => {
  const rcpt = ["friend@dev.test", "someone@example.com"];
  const hosted = ["dev.test"];

  it("sending_held: the server's words, the outside recipients from the draft and the docs link", () => {
    expect(sendProblem(new RefusedError(HELD, "sending_held"), rcpt, hosted)).toEqual({
      message: HELD,
      outside: ["someone@example.com"],
      learnMore: true,
    });
  });

  it("sending_held with nothing that looks outside (another customer's domain): no list, still the link", () => {
    expect(sendProblem(new RefusedError(HELD, "sending_held"), ["a@dev.test"], hosted)).toEqual({
      message: HELD,
      learnMore: true,
    });
  });

  it("sending_paused: the appeal address", () => {
    const p = sendProblem(new RefusedError("Sending is paused for this mailbox.", "sending_paused"), rcpt, hosted);
    expect(p).toEqual({ message: "Sending is paused for this mailbox.", appeal: SUPPORT_EMAIL });
  });

  it("sending_limit: the numbers from the server and that the draft is kept", () => {
    const msg = "You've reached your sending limit for now (10 recipients an hour, 25 a day). Try again later.";
    expect(sendProblem(new RefusedError(msg, "sending_limit"), rcpt, hosted).message).toBe(
      `${msg} Your draft is saved.`,
    );
  });

  it("billing_restricted and other refusals: the server's message as it is", () => {
    expect(sendProblem(new RefusedError("Billing paused sending.", "billing_restricted"), rcpt, hosted)).toEqual({
      message: "Billing paused sending.",
    });
    expect(sendProblem(new RefusedError("Only a saved draft can be sent."), rcpt, hosted)).toEqual({
      message: "Only a saved draft can be sent.",
    });
  });

  it("503: nothing was sent and the draft is saved", () => {
    expect(sendProblem(new UnavailableError("HTTP 503"), rcpt, hosted).message).toMatch(
      /isn't available right now, so nothing was sent/,
    );
  });

  it("anything else: check the connection; a signed-out session is passed on", () => {
    expect(sendProblem(new TypeError("fetch failed"), rcpt, hosted).message).toMatch(/Check your connection/);
    expect(() => sendProblem(new SignedOutError("signed out"), rcpt, hosted)).toThrow(SignedOutError);
  });
});
