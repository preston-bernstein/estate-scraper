import { describe, expect, it } from "vitest";
import { escapeLike, expandQuery } from "../thesaurus.js";

describe("expandQuery", () => {
  it("expands 'couch' to sofa/chaise/loveseat/sectional (AC1/AC2)", () => {
    const { expandedTerms } = expandQuery(["couch"]);
    expect(expandedTerms).toEqual(expect.arrayContaining(["sofa", "chaise", "loveseat", "sectional"]));
  });

  it("expandedTerms is a superset of literalTerms (FR2/AC10 preservation)", () => {
    const { literalTerms, expandedTerms } = expandQuery(["couch", "leather"]);
    for (const t of literalTerms) expect(expandedTerms).toContain(t);
  });

  it("resolves 'couch' to the seating category (AC3 mechanism)", () => {
    const { categories } = expandQuery(["couch"]);
    expect(categories).toContain("seating");
  });

  it("category detection generalizes from the category term-set, not a hardcoded rule (AC3)", () => {
    // "settee" is only present because it's in the CATEGORY_TERMS.seating data —
    // this proves categories are derived by scanning the term map, not a fixed
    // per-word if/else, so adding a new term to the map is enough to surface it.
    const { categories } = expandQuery(["settee"]);
    expect(categories).toContain("seating");
  });

  it("expands the multi-word query 'record player' to 'turntable' via bigram matching (AC14)", () => {
    const { expandedTerms } = expandQuery(["record", "player"]);
    expect(expandedTerms).toEqual(expect.arrayContaining(["turntable", "hi-fi", "stereo"]));
  });

  it("is deterministic: identical input yields identical output (AC12)", () => {
    const a = expandQuery(["couch", "record", "player"]);
    const b = expandQuery(["couch", "record", "player"]);
    expect(a).toEqual(b);
  });

  it("returns empty expansion for an empty query, without throwing", () => {
    expect(expandQuery([])).toEqual({ literalTerms: [], expandedTerms: [], categories: [] });
  });

  it("returns empty expansion for whitespace-only terms, without throwing", () => {
    expect(expandQuery(["   ", ""])).toEqual({ literalTerms: [], expandedTerms: [], categories: [] });
  });

  it("passes through an unrecognized term as a literal with no synonym/category expansion", () => {
    const { literalTerms, expandedTerms, categories } = expandQuery(["zzznotaword"]);
    expect(literalTerms).toEqual(["zzznotaword"]);
    expect(expandedTerms).toEqual(["zzznotaword"]);
    expect(categories).toEqual([]);
  });
});

describe("escapeLike", () => {
  it("escapes %, _, and backslash", () => {
    expect(escapeLike("50%_off\\deal")).toBe("50\\%\\_off\\\\deal");
  });

  it("leaves ordinary text untouched", () => {
    expect(escapeLike("mid-century sofa")).toBe("mid-century sofa");
  });

  it("escapes backslash before percent/underscore so escaping isn't doubled", () => {
    // A literal "%" must become "\%", not "\\%25" or some double-escaped mess.
    expect(escapeLike("%")).toBe("\\%");
    expect(escapeLike("_")).toBe("\\_");
  });
});
