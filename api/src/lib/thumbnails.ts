import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import sharp from "sharp";

// Durable thumbnails for every analyzed image (ADR 0013). Two jobs: the dashboard
// reference image, and — load-bearing — the re-embed source (ADR 0016). The source
// CDN 404s days after the sale, so once the listing is gone this file is the only
// way to recompute an embedding if the frozen model ever changes. Lives on the NAS
// in production (THUMBNAIL_DIR), local disk in dev.
const THUMBNAIL_DIR = process.env.THUMBNAIL_DIR ?? "./data/thumbnails";

// 512px max edge, q80 ≈ 15 KB. Big enough to re-embed faithfully (SigLIP downscales
// to its own input res anyway) and to read at a glance in the UI.
const THUMB_MAX_EDGE = 512;
const THUMB_QUALITY = 80;

// Deterministic, collision-free path: <dir>/<saleId>/<sha1(imageUrl)>.jpg. The hash
// keeps re-scans idempotent (same URL → same file) and sidesteps unsafe CDN filenames.
export function thumbnailPathFor(saleId: string, imageUrl: string): string {
  const hash = createHash("sha1").update(imageUrl).digest("hex");
  return join(THUMBNAIL_DIR, saleId, `${hash}.jpg`);
}

// THUMBNAIL_DIR is a NAS mount in production — mkdir is a network round trip, so
// avoid repeating it for every image once a sale's directory is known to exist.
const knownDirs = new Set<string>();

// Write a thumbnail from an already-downloaded image buffer. Fail-open: on any error
// returns null and the caller persists the image row with thumbnail_path NULL.
export async function writeThumbnail(
  saleId: string,
  imageUrl: string,
  buffer: Buffer,
): Promise<string | null> {
  const path = thumbnailPathFor(saleId, imageUrl);
  try {
    const jpeg = await sharp(buffer)
      .resize(THUMB_MAX_EDGE, THUMB_MAX_EDGE, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: THUMB_QUALITY })
      .toBuffer();
    const dir = dirname(path);
    if (!knownDirs.has(dir)) {
      await mkdir(dir, { recursive: true });
      knownDirs.add(dir);
    }
    await writeFile(path, jpeg);
    return path;
  } catch {
    return null;
  }
}
