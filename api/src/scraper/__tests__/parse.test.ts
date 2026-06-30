import { describe, expect, it } from "vitest";
import { parseSaleDetail } from "../parse.js";

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
});
