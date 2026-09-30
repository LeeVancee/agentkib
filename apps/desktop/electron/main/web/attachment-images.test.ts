// @vitest-environment node
import { describe, expect, it } from "vitest";
import { imageDimensions } from "./attachment-images";

describe("encoded image dimensions", () => {
  it("reads PNG and GIF dimensions from their binary headers", () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE1sAAAAASUVORK5CYII=",
      "base64",
    );
    const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
    expect(imageDimensions(png)).toEqual({ mime: "image/png", width: 1, height: 1 });
    expect(imageDimensions(gif)).toEqual({ mime: "image/gif", width: 1, height: 1 });
  });
  it("walks JPEG metadata segments before the size-bearing frame, rejecting segment overflow", () => {
    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc2, 0, 11, 8, 0, 10, 0, 20, 1, 1, 0x11, 0, 0xff,
      0xd9,
    ]);
    expect(imageDimensions(jpeg)).toEqual({ mime: "image/jpeg", width: 20, height: 10 });
    jpeg[5] = 255;
    expect(imageDimensions(jpeg)).toBeNull();
  });
  it.each(["VP8X", "VP8L", "VP8 "])(
    "reads the %s WebP layout and validates RIFF lengths",
    (kind) => {
      const webp = Buffer.alloc(kind === "VP8L" ? 26 : 30);
      webp.write("RIFF");
      webp.writeUInt32LE(webp.length - 8, 4);
      webp.write("WEBP", 8);
      webp.write(kind, 12);
      webp.writeUInt32LE(kind === "VP8L" ? 5 : 10, 16);
      if (kind === "VP8X") {
        webp.writeUIntLE(19, 24, 3);
        webp.writeUIntLE(9, 27, 3);
      } else if (kind === "VP8L") {
        webp[20] = 0x2f;
        webp.writeUInt32LE(19 | (9 << 14), 21);
      } else {
        Buffer.from([0x9d, 0x01, 0x2a]).copy(webp, 23);
        webp.writeUInt16LE(20, 26);
        webp.writeUInt16LE(10, 28);
      }
      expect(imageDimensions(webp)).toEqual({ mime: "image/webp", width: 20, height: 10 });
      webp.writeUInt32LE(999, 16);
      expect(imageDimensions(webp)).toBeNull();
    },
  );
  it("rejects truncated headers and unrelated data without throwing", () => {
    for (const prefix of [
      Buffer.from("GIF89a"),
      Buffer.from("RIFFxxxxWEBPVP8X"),
      Buffer.from([0xff, 0xd8, 0xff]),
      Buffer.from("not an image"),
    ]) {
      for (let end = 0; end <= prefix.length; end++)
        expect(imageDimensions(prefix.subarray(0, end))).toBeNull();
    }
  });
});
