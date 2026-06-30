export const OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://localhost:11436";
export const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "qwen3-vl:30b";

// Generator provenance (ADR 0016). Bump PROMPT_VERSION whenever VISION_USER_PROMPT
// or VISION_SYSTEM_PROMPT changes meaning, so findings/items carry the seam.
export const PROMPT_VERSION = "enriched-v1";

// The VLM that actually ran: managed API model when VISION_API_BASE is configured,
// otherwise the local Ollama model. Stamped on findings + finding_items.
export function activeVlmModel(): string {
  return VISION_API_BASE ? VISION_API_MODEL : OLLAMA_MODEL;
}
export const VISION_WORKERS = 2;
export const PREFILTER_WORKERS = 4;
export const PHASH_HAMMING_THRESHOLD = 10;

// ── Gate prompt: system + user split ─────────────────────────────────────────
// Research: long text in the user message competes with image tokens for VLM attention
// (visual attention degrades as text-to-token ratio rises). Keeping criteria in the system
// message leaves the user turn as image + minimal question → maximum visual focus.
// /no_think tells Qwen3 models to answer directly without chain-of-thought preamble.
export const LOCAL_GATE_SYSTEM =
  "/no_think\n" +
  "You route estate sale photos. Reply with exactly one word: PASS or SKIP.\n\n" +
  "SKIP — no resale value:\n" +
  "exterior, driveway, yard, empty room, bare wall/floor/ceiling, sale sign, price board, " +
  "HVAC/electrical panel/water heater, vehicle, person/pet, " +
  "cardboard boxes only, plastic storage bins/organizers, " +
  "flat-pack or particle-board furniture with no quality markers, " +
  "generic mass-market clothing with no brand or vintage signals, " +
  "cables/chargers/USB hubs/phone cases as the only items\n\n" +
  "PASS — may have resale value (uncertain → always PASS):\n" +
  "any furniture (wood, upholstered, metal — any style), art (framed or unframed), " +
  "electronics (vintage or modern), collectibles, jewelry, watches, " +
  "clothing with visible brand or vintage character, tools, musical instruments, " +
  "china/silver/crystal, lamps, clocks, books with readable titles, games, toys";

// Minimal user-turn content — image is attached here; brief question keeps text tokens low
// so the model's attention budget stays on the image rather than re-reading criteria.
export const LOCAL_GATE_PROMPT = "PASS or SKIP?";

// Managed API for full vision analysis — any OpenAI-compatible endpoint (Gemini, OpenRouter, RunPod, etc.)
// When set, replaces local Ollama for the full vision pass. Local gate still runs locally.
// Gemini: VISION_API_BASE=https://generativelanguage.googleapis.com/v1beta/openai
// RunPod: VISION_API_BASE=https://api.runpod.ai/v2/<endpoint_id>/openai/v1
export const VISION_API_BASE = process.env.VISION_API_BASE ?? "";
export const VISION_API_KEY = process.env.VISION_API_KEY ?? "";
export const VISION_API_MODEL = process.env.VISION_API_MODEL ?? "gemini-2.5-flash";

// System role — establishes context so the model doesn't need to infer it from the user message.
// Separating system/user is the correct usage of instruction-tuned models (Qwen, Llama, etc.)
// and is required for the Ollama /api/chat endpoint to use the model's proper instruction template.
export const VISION_SYSTEM_PROMPT =
  "You are scanning estate sale photos for a buyer with eclectic taste. " +
  "The buyer collects three things: (1) quality furniture and antiques, (2) kitsch and camp collectibles, " +
  "and (3) vintage electronics and video games. " +
  "\n\n" +
  "FURNITURE AND ANTIQUES: sofas, sectionals, loveseats, beds, dressers, credenzas, armoires, " +
  "named-brand furniture (Stickley, Henredon, Baker, Drexel, Broyhill, Lane, etc.), " +
  "grandfather clocks, art pottery, silverware, china, vintage lamps. " +
  "\n\n" +
  "KITSCH AND CAMP: velvet paintings, paint-by-number artwork, taxidermy, ceramic novelty figures " +
  "(poodles, flamingos, roosters, religious figures), tiki items, vintage bar ware with novelty designs, " +
  "gaudy or outsider art, vintage carnival prizes, kitschy Americana, lava lamps, snow globes, " +
  "vintage holiday decorations, anything that could be described as gloriously tacky or camp. " +
  "\n\n" +
  "VINTAGE ELECTRONICS AND VIDEO GAMES: game consoles (Atari, ColecoVision, Intellivision, NES, Sega, etc.), " +
  "handheld games, arcade cabinets, vintage tube radios, vintage televisions (especially tube or console TVs), " +
  "reel-to-reel tape players, vintage hi-fi equipment (turntables, receivers, amplifiers, speakers), " +
  "vintage cameras (Polaroid, rangefinder, SLR), vintage computers (Apple II, Commodore 64, TRS-80, etc.). " +
  "\n\n" +
  "For each item note any visible brand labels or maker's marks, the apparent style or era, " +
  "and condition only when damage is clearly visible. " +
  "You only describe what is physically visible. You do not guess or infer.";

// User turn — enriched format requesting brand/era/condition alongside color+material.
// chat-plain scored 89% detection + 100% specificity in eval; structured output scored only 50%.
// Confidence tags ([high]/[medium]/[low]) appended per line; plain-text outperforms JSON constraint.
export const VISION_USER_PROMPT =
  "List every notable item visible in this photo, one per line. " +
  "For furniture: color + material + style + era (e.g. brown leather Chesterfield sofa, walnut mid-century credenza). " +
  "For kitsch and camp: describe what makes it kitschy — subject, medium, style " +
  "(e.g. velvet Elvis painting, ceramic rooster lamp, paint-by-number seascape, taxidermy deer head). " +
  "For vintage electronics and games: brand + type + model if visible " +
  "(e.g. Atari 2600 console, Pioneer reel-to-reel, Zenith console TV, Commodore 64). " +
  "Include brand or maker's mark only if a label is clearly readable. " +
  "Include condition only if damage or wear is clearly visible. " +
  "End each line with [high], [medium], or [low] to indicate how clearly visible and confidently identifiable the item is. " +
  "If nothing notable: NOTHING";

// JSON schema passed to Ollama's `format` field — constrains output to structured data.
export const VISION_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          description: { type: "string" },
          category: {
            type: "string",
            enum: ["seating", "bed", "case_goods", "collectible", "decor", "other"],
          },
        },
        required: ["description", "category"],
      },
    },
  },
  required: ["items"],
} as const;

// Legacy flat prompt kept for the eval harness prompt-comparison runs (baseline / generate endpoint).
export const VISION_PROMPT_LEGACY =
  "List the valuable items you see in this estate sale photo. Be specific: for upholstered seating include color, material, and style (e.g. 'navy velvet tufted sectional', 'brown leather Chesterfield sofa', 'cream linen loveseat'). For other items use the specific name (e.g. 'Stickley armchair', 'Tiffany lamp', 'grandfather clock'). Short list only — one item per line. If nothing valuable is visible, respond with exactly one word: NOTHING.";
