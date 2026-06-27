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

    it("rejects responses over 1400 characters regardless of content", () => {
      // Guard against truly verbose paragraph responses even when they contain item names.
      // 1400 chars allows ~15 items at ~90 chars each (color+material+era+condition + confidence tag).
      const longResponse = "a".repeat(1401);
      expect(longResponse.length).toBeGreaterThan(1400);
      expect(hasFindings(longResponse)).toBe(false);
    });

    it("accepts enriched descriptions with confidence tags up to 1400 characters", () => {
      // Multi-item list with color + material + era + condition + confidence tag
      const enriched = [
        "brown leather Chesterfield sofa, good condition [high]",
        "walnut mid-century credenza, veneer bubbling on top [medium]",
        "Stickley oak armchair, Arts & Crafts, label visible [high]",
        "mahogany Victorian dresser with brass bail pulls [medium]",
        "grandfather clock with ornate carved case [high]",
        "Atari 2600 console with cartridges [high]",
        "velvet Elvis painting [medium]",
        "ceramic rooster lamp [low]",
        "paint-by-number seascape [medium]",
        "Pioneer reel-to-reel tape player [high]",
      ].join("\n");
      expect(enriched.length).toBeLessThanOrEqual(1400);
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

  describe("confidence tags (Phase 3)", () => {
    it("accepts items with [high] confidence tag", () => {
      expect(hasFindings("Stickley armchair [high]")).toBe(true);
    });

    it("accepts items with [medium] confidence tag", () => {
      expect(hasFindings("brown leather Chesterfield sofa [medium]")).toBe(true);
    });

    it("accepts items with [low] confidence tag", () => {
      expect(hasFindings("velvet painting [low]")).toBe(true);
    });

    it("accepts multi-item list with mixed confidence tags", () => {
      expect(
        hasFindings(
          "Stickley armchair [high]\nAtari 2600 console [high]\nceramic rooster lamp [medium]",
        ),
      ).toBe(true);
    });

    it("still rejects NOTHING even with confidence tags present in other context", () => {
      expect(hasFindings("NOTHING")).toBe(false);
    });

    it("accepts items where confidence tag uses uppercase", () => {
      expect(hasFindings("grandfather clock [HIGH]")).toBe(true);
    });
  });
});
