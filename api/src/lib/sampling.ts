// Adaptive sampling thresholds
export const LEAD_SAMPLE_PCT = 0.25;       // Phase 1: first 25% of a sale's images
export const TAIL_SAMPLE_PCT_START = 0.70; // Phase 2: tail probe starts at 70%
export const TAIL_SAMPLE_K = 8;            // Phase 2: how many tail images to probe
export const SWITCH_SCORE_THRESHOLD = 0.1; // score below this after lead → tail probe
export const HIGH_SCORE_THRESHOLD = 0.8;   // score at/above this → full analysis, skip tail check

// Oracle escalation (OpenAI-compatible remote API — set to RunPod, Together, Hyperbolic, etc.)
export const ORACLE_API_BASE = process.env.ORACLE_API_BASE ?? "";
export const ORACLE_API_KEY = process.env.ORACLE_API_KEY ?? "";
export const ORACLE_MODEL = process.env.ORACLE_MODEL ?? "";
export const ORACLE_SCORE_MIN = 0.1; // uncertain zone lower bound (inclusive)
export const ORACLE_SCORE_MAX = 0.6; // uncertain zone upper bound (exclusive)
