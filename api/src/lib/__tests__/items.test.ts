import { describe, expect, it } from "vitest";
import { classifyCategory, extractItems, inferDesirability, inferEra } from "../items.js";
import { resolveMakers } from "../lexicon.js";

describe("resolveMakers", () => {
  it("resolves a known maker to its canonical name", () => {
    expect(resolveMakers("Stickley oak armchair")).toEqual([{ maker: "Stickley", raw: "stickley" }]);
  });

  it("prefers the longest alias (atari 2600 over atari)", () => {
    expect(resolveMakers("Atari 2600 console")[0]).toEqual({ maker: "Atari", raw: "atari 2600" });
  });

  it("handles punctuated aliases", () => {
    expect(resolveMakers("Reed & Barton sterling")[0]?.maker).toBe("Reed & Barton");
  });

  it("does not fire on substrings (lane inside planer, baker inside bakery)", () => {
    expect(resolveMakers("wood planer")).toEqual([]);
    expect(resolveMakers("old bakery sign")).toEqual([]);
  });

  it("returns empty for unknown makers", () => {
    expect(resolveMakers("generic pine bookshelf")).toEqual([]);
  });

  it("de-dupes a canonical that matches via two aliases", () => {
    const r = resolveMakers("Wedgwood wedgewood plate");
    expect(r.filter((m) => m.maker === "Wedgwood")).toHaveLength(1);
  });
});

describe("classifyCategory", () => {
  it.each([
    ["brown leather Chesterfield sofa", "seating"],
    ["walnut mid-century credenza", "case_goods"],
    ["mahogany dining table", "tables"],
    ["four-poster bed", "beds"],
    ["brass floor lamp", "lighting"],
    ["ceramic rooster lamp", "kitsch"],
    ["grandfather clock", "clocks"],
    ["velvet Elvis painting", "kitsch"],
    ["oil on canvas landscape", "art"],
    ["Roseville pottery vase", "ceramics_glass"],
    ["sterling silverware set", "silver"],
    ["gold pocket watch", "jewelry_watches"],
    ["Pioneer reel-to-reel tape player", "electronics"],
    ["Atari 2600 console with cartridges", "games_toys"],
    ["acoustic guitar", "instruments"],
    ["box of garden hoses", "other"],
  ])("%s -> %s", (line, expected) => {
    expect(classifyCategory(line)).toBe(expected);
  });

  it("kitsch beats furniture when both signals present", () => {
    expect(classifyCategory("velvet painting on a chair")).toBe("kitsch");
  });
});

describe("inferEra", () => {
  it.each([
    ["walnut 1950s credenza", "1950s"],
    ["mid-century modern lamp", "mid-century"],
    ["Art Deco mirror", "Art Deco"],
    ["Victorian fainting couch", "Victorian"],
    ["antique oak desk", "antique"],
    ["circa 1920 clock", "circa 1920"],
    ["just a plain chair", null],
  ])("%s -> %s", (line, expected) => {
    expect(inferEra(line)).toBe(expected);
  });

  it("prefers a decade over a generic vintage signal", () => {
    expect(inferEra("vintage 1960s radio")).toBe("1960s");
  });
});

describe("inferDesirability", () => {
  it("maker hit -> high", () => expect(inferDesirability(1, null)).toBe("high"));
  it("premium era -> high", () => expect(inferDesirability(0, "Victorian")).toBe("high"));
  it("plain vintage -> med", () => expect(inferDesirability(0, "vintage")).toBe("med"));
  it("nothing special -> med", () => expect(inferDesirability(0, null)).toBe("med"));
});

describe("extractItems", () => {
  it("makes one item per line and maps confidence to item scale", () => {
    const items = extractItems({
      description: "Stickley oak armchair\nwalnut mid-century credenza\nplastic storage bin",
      confidence: "medium",
    });
    expect(items).toHaveLength(3);
    expect(items.every((i) => i.idConfidence === "med")).toBe(true);

    expect(items[0]).toMatchObject({
      maker: "Stickley",
      makerRaw: "stickley",
      category: "seating",
      desirability: "high",
      source: "lexicon",
      matchedLexicon: ["Stickley"],
    });
    expect(items[1]).toMatchObject({
      maker: null,
      category: "case_goods",
      era: "mid-century",
      desirability: "high", // premium era
      source: "vlm",
    });
    expect(items[2]).toMatchObject({ category: "other", desirability: "med", source: "vlm" });
  });

  it("ignores blank lines", () => {
    expect(extractItems({ description: "  \n\nCouch\n  \n", confidence: null })).toHaveLength(1);
  });

  it("defaults idConfidence to med when finding confidence is null", () => {
    expect(extractItems({ description: "Couch", confidence: null })[0]!.idConfidence).toBe("med");
  });
});
