// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { firstName, greetingFor } from "./greeting-text";

describe("home greeting", () => {
  it("follows the time of day", () => {
    expect(greetingFor(5)).toBe("Good morning");
    expect(greetingFor(11)).toBe("Good morning");
    expect(greetingFor(12)).toBe("Good afternoon");
    expect(greetingFor(17)).toBe("Good afternoon");
    expect(greetingFor(18)).toBe("Good evening");
    expect(greetingFor(2)).toBe("Good evening");
  });

  it("uses the first word of the name, else the email's local part", () => {
    expect(firstName("Pat Parent", "p@x.test")).toBe("Pat");
    expect(firstName("  ", "kim@x.test")).toBe("kim");
    expect(firstName(null, "kim@x.test")).toBe("kim");
  });
});
