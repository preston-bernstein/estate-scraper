import { describe, expect, it } from "vitest";
import { hasFindings } from "../index.js";

describe("hasFindings", () => {
  describe("empty / NOTHING responses", () => {
    it("rejects empty string", () => {
      expect(hasFindings("")).toBe(false);
    });

    it("rejects whitespace-only string", () => {
      expect(hasFindings("   \n  ")).toBe(false);
    });

    it("rejects exact NOTHING", () => {
      expect(hasFindings("NOTHING")).toBe(false);
    });

    it("rejects lowercase nothing", () => {
      expect(hasFindings("nothing")).toBe(false);
    });

    it("rejects NOTHING with surrounding whitespace", () => {
      expect(hasFindings("  NOTHING  ")).toBe(false);
    });
  });

  describe("valid findings", () => {
    it("accepts a single item", () => {
      expect(hasFindings("Couch")).toBe(true);
    });

    it("accepts a specific furniture description", () => {
      expect(hasFindings("brown leather Chesterfield sofa")).toBe(true);
    });

    it("accepts a multi-line list", () => {
      expect(hasFindings("Stickley armchair\ngrandfather clock\nTiffany lamp")).toBe(true);
    });

    it("accepts a list with commas", () => {
      expect(hasFindings("Couch, coffee table, ottoman")).toBe(true);
    });

    it("accepts collectible item names", () => {
      expect(hasFindings("grandfather clock")).toBe(true);
    });
  });

  describe("junk key:value lines", () => {
    it("rejects all-zero key:value lines", () => {
      expect(hasFindings("Furniture: 0\nJewelry: none\nArt: NONE VISIBLE")).toBe(false);
    });

    it("accepts when some lines are real despite junk", () => {
      expect(hasFindings("Furniture: 0\nStickley armchair")).toBe(true);
    });

    it("rejects single line ending in : 0", () => {
      expect(hasFindings("Couches: 0")).toBe(false);
    });
  });

  describe("verbose paragraph rejection", () => {
    it("rejects responses starting with 'The image'", () => {
      expect(
        hasFindings(
          "The image shows a living room with various items including a sofa and coffee table.",
        ),
      ).toBe(false);
    });

    it("rejects responses starting with 'I can'", () => {
      expect(
        hasFindings("I can see several items in this estate sale photo including furniture."),
      ).toBe(false);
    });

    it("rejects responses starting with 'This image'", () => {
      expect(hasFindings("This image appears to show a bedroom with a bed and dresser.")).toBe(
        false,
      );
    });

    it("rejects responses starting with 'In this image'", () => {
      expect(hasFindings("In this image there are several pieces of furniture visible.")).toBe(
        false,
      );
    });

    it("rejects responses starting with 'The photo'", () => {
      expect(hasFindings("The photo shows what appears to be a vintage armchair.")).toBe(false);
    });

    it("rejects responses over 1000 characters regardless of content", () => {
      // Guard against truly verbose paragraph responses even when they contain item names.
      // 1000 chars allows ~10 items at ~80 chars each (color+material+era+condition).
      const longResponse = "a".repeat(1001);
      expect(longResponse.length).toBeGreaterThan(1000);
      expect(hasFindings(longResponse)).toBe(false);
    });

    it("accepts enriched descriptions up to 1000 characters", () => {
      // Multi-item list with color + material + era + condition attributes
      const enriched = [
        "brown leather Chesterfield sofa, good condition",
        "walnut mid-century credenza, veneer bubbling on top",
        "Stickley oak armchair, Arts & Crafts, label visible",
        "mahogany Victorian dresser with brass bail pulls",
        "grandfather clock with ornate carved case",
      ].join("\n");
      expect(enriched.length).toBeLessThanOrEqual(1000);
      expect(hasFindings(enriched)).toBe(true);
    });

    it("accepts a verbose-looking but short response", () => {
      expect(hasFindings("navy velvet sectional sofa\nwalnut mid-century credenza")).toBe(true);
    });
  });

  describe("edge cases", () => {
    it("handles mixed case NOTHING", () => {
      expect(hasFindings("Nothing")).toBe(false);
    });

    it("accepts description with a number in it", () => {
      expect(hasFindings("Set of 4 dining chairs")).toBe(true);
    });

    it("accepts description with special characters", () => {
      expect(hasFindings("Tiffany-style lamp (circa 1920s)")).toBe(true);
    });

    it("rejects all junk lines across multiple formats", () => {
      expect(
        hasFindings("Furniture: 0\nArt: NONE\nJewelry: NONE VISIBLE"),
      ).toBe(false);
    });
  });
});
