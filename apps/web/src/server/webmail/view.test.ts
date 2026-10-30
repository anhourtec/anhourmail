// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { onBehalfSender } from "./view";

const desk = { name: "Front desk", email: "desk@family.test" };
const kim = { name: "Kim", email: "kim@family.test" };

describe("on behalf of (the Sender header, ADR-0026)", () => {
  it("shows a Sender that isn't the From", () => {
    expect(onBehalfSender([desk], [kim])).toEqual([kim]);
  });

  it("shows nothing for no Sender, a Sender equal to the From, or several addresses on either side", () => {
    expect(onBehalfSender([desk], [])).toEqual([]);
    expect(onBehalfSender([desk], [{ name: null, email: " DESK@family.test " }])).toEqual([]);
    expect(onBehalfSender([desk, kim], [kim])).toEqual([]);
    expect(onBehalfSender([desk], [kim, desk])).toEqual([]);
    expect(onBehalfSender([], [kim])).toEqual([]);
  });
});
