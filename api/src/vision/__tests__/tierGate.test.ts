import { describe, expect, it } from "vitest";
import { decideLeadOutcome, shouldEscalateToOracle } from "../index.js";
import {
  HIGH_SCORE_THRESHOLD,
  ORACLE_SCORE_MAX,
  ORACLE_SCORE_MIN,
  SWITCH_SCORE_THRESHOLD,
} from "../../lib/sampling.js";

// decideLeadOutcome and shouldEscalateToOracle are the actual money-spending
// decisions in the scan pipeline (how much of a sale gets the paid VLM pass, and
// whether an uncertain sale escalates to the even-more-expensive oracle). Boundary
// values here are exactly where a regression (an inverted comparison, an off-by-one
// on >= vs >) would silently change vision spend with no test catching it.
describe("decideLeadOutcome", () => {
  it("returns FULL when the lead sample already covers the whole sale", () => {
    expect(decideLeadOutcome(0, 5, 5)).toBe("FULL");
  });

  it("returns FULL just below HIGH_SCORE_THRESHOLD only if lead covers everything", () => {
    // leadCount < total and score below threshold — must NOT be FULL via score alone
    expect(decideLeadOutcome(HIGH_SCORE_THRESHOLD - 0.01, 2, 10)).not.toBe("FULL");
  });

  it("returns FULL at exactly HIGH_SCORE_THRESHOLD (inclusive boundary)", () => {
    expect(decideLeadOutcome(HIGH_SCORE_THRESHOLD, 2, 10)).toBe("FULL");
  });

  it("returns FULL above HIGH_SCORE_THRESHOLD", () => {
    expect(decideLeadOutcome(HIGH_SCORE_THRESHOLD + 1, 2, 10)).toBe("FULL");
  });

  it("returns TAIL_PROBE_CANDIDATE just below SWITCH_SCORE_THRESHOLD", () => {
    expect(decideLeadOutcome(SWITCH_SCORE_THRESHOLD - 0.01, 2, 10)).toBe(
      "TAIL_PROBE_CANDIDATE",
    );
  });

  it("does NOT return TAIL_PROBE_CANDIDATE at exactly SWITCH_SCORE_THRESHOLD (exclusive boundary)", () => {
    expect(decideLeadOutcome(SWITCH_SCORE_THRESHOLD, 2, 10)).toBe("INTERMEDIATE");
  });

  it("returns INTERMEDIATE strictly between the two thresholds", () => {
    const mid = (SWITCH_SCORE_THRESHOLD + HIGH_SCORE_THRESHOLD) / 2;
    expect(decideLeadOutcome(mid, 2, 10)).toBe("INTERMEDIATE");
  });

  it("prioritizes FULL over TAIL_PROBE_CANDIDATE when the lead sample is the whole sale, even with score 0", () => {
    expect(decideLeadOutcome(0, 3, 3)).toBe("FULL");
  });
});

describe("shouldEscalateToOracle", () => {
  it("never escalates when the oracle isn't configured", () => {
    expect(shouldEscalateToOracle(false, 5, ORACLE_SCORE_MIN)).toBe(false);
  });

  it("never escalates with zero findings even in the uncertain band", () => {
    expect(shouldEscalateToOracle(true, 0, ORACLE_SCORE_MIN)).toBe(false);
  });

  it("does not escalate just below ORACLE_SCORE_MIN (exclusive lower boundary excluded)", () => {
    expect(shouldEscalateToOracle(true, 1, ORACLE_SCORE_MIN - 0.01)).toBe(false);
  });

  it("escalates at exactly ORACLE_SCORE_MIN (inclusive lower boundary)", () => {
    expect(shouldEscalateToOracle(true, 1, ORACLE_SCORE_MIN)).toBe(true);
  });

  it("escalates just below ORACLE_SCORE_MAX", () => {
    expect(shouldEscalateToOracle(true, 1, ORACLE_SCORE_MAX - 0.01)).toBe(true);
  });

  it("does not escalate at exactly ORACLE_SCORE_MAX (exclusive upper boundary)", () => {
    expect(shouldEscalateToOracle(true, 1, ORACLE_SCORE_MAX)).toBe(false);
  });

  it("does not escalate above ORACLE_SCORE_MAX — clearly-good sales skip the oracle", () => {
    expect(shouldEscalateToOracle(true, 1, ORACLE_SCORE_MAX + 1)).toBe(false);
  });
});
