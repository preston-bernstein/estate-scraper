export const OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://YOUR_DESKTOP_IP:11434";
export const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "qwen2.5vl:7b-q8_0";
export const VISION_WORKERS = 6;

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
// This replaces all hasFindings heuristics and free-text LIKE queries for the chat endpoint.
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
