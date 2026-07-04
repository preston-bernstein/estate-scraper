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

  it("clamps the longest edge to exactly 512 while preserving aspect ratio", async () => {
    const { writeThumbnail } = await import("../thumbnails.js");
    const wide = await sharp({
      create: { width: 2000, height: 1000, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .jpeg()
      .toBuffer();
    const path = await writeThumbnail("GA-wide", "https://x/wide.jpg", wide);
    const meta = await sharp(readFileSync(path!)).metadata();
    // 2:1 aspect, longest edge clamped to 512 → 512x256.
    expect(meta.width).toBe(512);
    expect(meta.height).toBe(256);
  });

  it("does not enlarge an image already smaller than the max edge", async () => {
    const { writeThumbnail } = await import("../thumbnails.js");
    const small = await sharp({
      create: { width: 100, height: 80, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .jpeg()
      .toBuffer();
    const path = await writeThumbnail("GA-small", "https://x/small.jpg", small);
    const meta = await sharp(readFileSync(path!)).metadata();
    expect(meta.width).toBe(100);
    expect(meta.height).toBe(80);
  });

  it("derives distinct paths for distinct urls and sale ids", async () => {
    const { thumbnailPathFor } = await import("../thumbnails.js");
    const a = thumbnailPathFor("sale-1", "https://x/one.jpg");
    const b = thumbnailPathFor("sale-1", "https://x/two.jpg");
    const c = thumbnailPathFor("sale-2", "https://x/one.jpg");
    expect(a).not.toBe(b); // different url → different hash filename
    expect(a).not.toBe(c); // different saleId → different directory
    expect(a).toContain("sale-1");
    expect(c).toContain("sale-2");
    // Same inputs are stable.
    expect(thumbnailPathFor("sale-1", "https://x/one.jpg")).toBe(a);
  });
});
