// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { AVATAR } from "@anhourmail/shared/profile";

import { centreSquare, PHOTO_ACCEPT, photoFileProblem } from "./photo-file";

describe("photo files in the browser", () => {
  it("accepts PNG, JPEG and WebP up to the shared size; refuses SVG, GIF and larger files", () => {
    expect(PHOTO_ACCEPT).toBe("image/png,image/jpeg,image/webp");
    expect(photoFileProblem({ type: "image/png", size: 1000 })).toBeNull();
    expect(photoFileProblem({ type: "image/webp", size: AVATAR.maxUploadMb * 1024 * 1024 })).toBeNull();
    expect(photoFileProblem({ type: "image/svg+xml", size: 10 })).toMatch(/PNG, JPEG or WebP/);
    expect(photoFileProblem({ type: "image/gif", size: 10 })).toMatch(/PNG, JPEG or WebP/);
    expect(photoFileProblem({ type: "text/html", size: 10 })).toMatch(/PNG, JPEG or WebP/);
    expect(photoFileProblem({ type: "image/jpeg", size: AVATAR.maxUploadMb * 1024 * 1024 + 1 })).toMatch(/up to/);
  });

  it("crops to the centred square", () => {
    expect(centreSquare(400, 300)).toEqual({ x: 50, y: 0, side: 300 });
    expect(centreSquare(300, 401)).toEqual({ x: 0, y: 50, side: 300 });
    expect(centreSquare(64, 64)).toEqual({ x: 0, y: 0, side: 64 });
  });
});
