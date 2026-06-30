import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "es-thumb-"));
  process.env.THUMBNAIL_DIR = dir;
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("writeThumbnail", () => {
  it("writes a downscaled JPEG under <dir>/<saleId>/ and is idempotent on URL", async () => {
    // Import after THUMBNAIL_DIR is set so the module reads the temp dir.
    const { writeThumbnail, thumbnailPathFor } = await import("../thumbnails.js");

    const big = await sharp({
      create: { width: 2000, height: 1500, channels: 3, background: { r: 120, g: 80, b: 40 } },
    })
      .jpeg()
      .toBuffer();

    const url = "https://picturescdn.estatesales.net/abc/photo1.jpg";
    const path = await writeThumbnail("GA-12345", url, big);

    expect(path).toBe(thumbnailPathFor("GA-12345", url));
    expect(path).toContain(join(dir, "GA-12345"));
    expect(path!.endsWith(".jpg")).toBe(true);

    // Resized: longest edge clamped to 512.
    const meta = await sharp(readFileSync(path!)).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(512);

    // Same URL → same deterministic path.
    const again = await writeThumbnail("GA-12345", url, big);
    expect(again).toBe(path);
  });

  it("fails open (returns null) on an invalid image buffer", async () => {
    const { writeThumbnail } = await import("../thumbnails.js");
    const path = await writeThumbnail("GA-1", "https://x/y.jpg", Buffer.from("not an image"));
    expect(path).toBeNull();
  });
});
