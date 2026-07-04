import { describe, expect, it } from "vitest";
import { parseListingLinks, parseSaleDetail } from "../parse.js";

const URL = "https://www.estatesales.net/GA/Decatur/30033/12345";

// Minimal stand-in for the schema.org JSON estatesales.net embeds in the page.
function page(fields: Partial<Record<string, string>>): string {
  const f = {
    startDate: "2026-07-01T14:00:00.000Z",
    endDate: "2026-07-03T20:00:00.000Z",
    addressLine1: "123 Main St",
    addressLocality: "Decatur",
    addressRegion: "GA",
    postalCode: "30033",
    ...fields,
  };
  const json = Object.entries(f)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `"${k}":"${v}"`)
    .join(",");
  return `<html><meta property="og:title" content="Test Sale"/>{${json}}</html>`;
}

describe("parseSaleDetail", () => {
  it("parses a fully-specified listing", () => {
    const d = parseSaleDetail(page({}), URL);
    expect(d).not.toBeNull();
    expect(d).toMatchObject({
      saleId: "12345",
      address: "123 Main St",
      city: "Decatur",
      state: "GA",
      zip: "30033",
      startDate: "2026-07-01",
      endDate: "2026-07-03",
    });
  });

  it("parses when the street is withheld (addressLine1 empty) — the regression", () => {
    const d = parseSaleDetail(page({ addressLine1: "" }), URL);
    expect(d).not.toBeNull();
    expect(d!.address).toBe(""); // street optional
    expect(d!.city).toBe("Decatur"); // city/state/zip still drive geocoding
    expect(d!.zip).toBe("30033");
  });

  it("recovers location from the URL when the JSON address block is absent", () => {
    const d = parseSaleDetail(
      page({ addressLine1: "", addressLocality: undefined, addressRegion: undefined, postalCode: undefined }),
      "https://www.estatesales.net/GA/Mountain-City/30562/4974030",
    );
    expect(d).not.toBeNull();
    expect(d).toMatchObject({ city: "Mountain City", state: "GA", zip: "30562", address: "" });
  });

  it("rejects when location is unrecoverable from both JSON and URL", () => {
    const d = parseSaleDetail(
      page({ addressLine1: "", addressLocality: undefined, addressRegion: undefined, postalCode: undefined }),
      "https://www.estatesales.net/sale/12345", // malformed: no /STATE/City/ZIP/
    );
    expect(d).toBeNull();
  });

  it("rejects a listing missing dates", () => {
    expect(parseSaleDetail(page({ startDate: undefined }), URL)).toBeNull();
    expect(parseSaleDetail(page({ endDate: undefined }), URL)).toBeNull();
  });

  it("truncates ISO datetimes to date-only (YYYY-MM-DD)", () => {
    const d = parseSaleDetail(page({ startDate: "2026-12-25T09:30:00.000Z" }), URL)!;
    expect(d.startDate).toBe("2026-12-25");
    expect(d.startDate).toHaveLength(10);
  });

  it("prefers og:title, falls back to <title>, then to saleId", () => {
    // og:title present wins.
    expect(parseSaleDetail(page({}), URL)!.title).toBe("Test Sale");

    // No og:title → <title> element.
    const titleOnly =
      `<html><title>Fallback Title</title>{"startDate":"2026-07-01T00:00:00Z",` +
      `"endDate":"2026-07-03T00:00:00Z","addressLocality":"Decatur",` +
      `"addressRegion":"GA","postalCode":"30033"}</html>`;
    expect(parseSaleDetail(titleOnly, URL)!.title).toBe("Fallback Title");

    // Neither → saleId from the URL.
    const noTitle =
      `<html>{"startDate":"2026-07-01T00:00:00Z","endDate":"2026-07-03T00:00:00Z",` +
      `"addressLocality":"Decatur","addressRegion":"GA","postalCode":"30033"}</html>`;
    expect(parseSaleDetail(noTitle, URL)!.title).toBe("12345");
  });

  it("strips a trailing 'starts on ...' suffix from the title", () => {
    const html = page({}).replace(
      'content="Test Sale"',
      'content="Estate Sale starts on Friday July 1"',
    );
    expect(parseSaleDetail(html, URL)!.title).toBe("Estate Sale");
  });

  it("prefers JSON address fields over the URL-derived location", () => {
    // JSON says Decatur/GA/30033; URL says a different city/zip — JSON wins.
    const d = parseSaleDetail(page({}), "https://www.estatesales.net/FL/Miami/33101/12345")!;
    expect(d).toMatchObject({ city: "Decatur", state: "GA", zip: "30033" });
  });

  it("extracts CDN image urls, skips filtered patterns, and dedupes", () => {
    const imgs =
      'https://picturescdn.estatesales.net/a/photo1.jpg ' +
      'https://picturescdn.estatesales.net/a/photo1.jpg ' + // duplicate
      'https://picturescdn.estatesales.net/a/photo2.PNG ' +
      'https://picturescdn.estatesales.net/a/logo-placeholder.jpg '; // filtered (if pattern matches)
    const html = page({}).replace("</html>", `${imgs}</html>`);
    const d = parseSaleDetail(html, URL)!;
    // photo1 appears once despite two occurrences; photo2 (case-insensitive ext) included.
    expect(d.imageUrls.filter((u) => u.includes("photo1"))).toHaveLength(1);
    expect(d.imageUrls.some((u) => u.toLowerCase().includes("photo2"))).toBe(true);
  });
});

describe("parseListingLinks", () => {
  const link = (href: string, extra = "") =>
    `<a href="${href}"${extra}>x</a>`;

  it("extracts a well-formed /STATE/City/ZIP/id listing href", () => {
    const html = link("/GA/Decatur/30033/12345");
    const links = parseListingLinks(html);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      saleId: "12345",
      url: "https://www.estatesales.net/GA/Decatur/30033/12345",
    });
  });

  it("returns every distinct listing on the page", () => {
    const html = link("/GA/Decatur/30033/111") + link("/FL/Miami/33101/222");
    const links = parseListingLinks(html);
    expect(links.map((l) => l.saleId).sort()).toEqual(["111", "222"]);
  });

  it("dedupes repeated sale ids", () => {
    const html = link("/GA/Decatur/30033/999") + link("/GA/Decatur/30033/999");
    expect(parseListingLinks(html)).toHaveLength(1);
  });

  it("ignores hrefs that are not listings", () => {
    const html =
      link("/about") +
      link("/GA/Decatur/blog") +
      link("https://external.example.com/GA/Decatur/30033/1");
    expect(parseListingLinks(html)).toHaveLength(0);
  });

  it("requires a two-letter uppercase state and five-digit zip", () => {
    // lowercase state, 4-digit zip, 6-digit zip — all rejected.
    const html =
      link("/ga/Decatur/30033/1") +
      link("/GA/Decatur/3003/2") +
      link("/GA/Decatur/300333/3");
    expect(parseListingLinks(html)).toHaveLength(0);
  });
});
