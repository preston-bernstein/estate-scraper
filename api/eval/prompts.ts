// Each variant defines how to call the model.
// - Chat variants (systemPrompt + userPrompt): use /api/chat with the model's instruction template.
//   structuredOutput:true adds the JSON schema constraint via the Ollama `format` field.
// - Legacy variants (legacyPrompt only): use /api/generate (flat text, no schema).
//   Useful for baselining against older behavior and non-instruction models.

export type PromptVariant = {
  name: string;
  description: string;
  // Chat format — preferred for instruction-tuned models (Qwen, Llama 3, etc.)
  systemPrompt?: string;
  userPrompt?: string;
  structuredOutput?: boolean;
  // Legacy flat-text format — for /api/generate comparisons
  legacyPrompt?: string;
};

// System prompt shared across all chat variants
const SYSTEM =
  "You are scanning estate sale photos for a buyer looking for furniture, collectibles, and antiques. " +
  "You identify items worth attending a sale for: sofas, sectionals, loveseats, beds, dressers, credenzas, " +
  "armoires, named-brand furniture (Stickley, Henredon, Baker, Drexel, Broyhill, Lane, etc.), " +
  "vintage lamps, grandfather clocks, artwork, jewelry, silverware, china, and other notable pieces. " +
  "You only describe what is physically visible. You do not guess or infer.";

export const prompts: PromptVariant[] = [
  {
    name: "legacy-baseline",
    description: "Original flat prompt, /api/generate, no schema. Reference floor.",
    legacyPrompt:
      "You are scanning an estate sale photo for valuable items. Respond with a short list of the specific valuable objects you actually see. Only name objects physically visible in the image. Do NOT list categories, do NOT say 'none', do NOT use key:value format. If nothing valuable is visible, respond with exactly one word: NOTHING.",
  },
  {
    name: "legacy-current",
    description: "Current flat prompt, /api/generate, no schema. llava-compatible.",
    legacyPrompt:
      "List the valuable items you see in this estate sale photo. Be specific: for upholstered seating include color, material, and style (e.g. 'navy velvet tufted sectional', 'brown leather Chesterfield sofa', 'cream linen loveseat'). For other items use the specific name (e.g. 'Stickley armchair', 'Tiffany lamp', 'grandfather clock'). Short list only — one item per line. If nothing valuable is visible, respond with exactly one word: NOTHING.",
  },
  {
    name: "chat-plain",
    description: "Chat API with system prompt, no JSON schema. Requires chat template (qwen2.5vl, llama3.2-vision).",
    systemPrompt: SYSTEM,
    userPrompt:
      "List every notable item visible in this photo, one per line. " +
      "For seating: color + material + style (e.g. brown leather Chesterfield sofa). " +
      "For beds: size + style if visible. " +
      "For case goods: material + type (e.g. oak dresser). " +
      "For collectibles: specific name (e.g. grandfather clock, Stickley armchair). " +
      "If nothing notable: NOTHING",
    structuredOutput: false,
  },
  {
    name: "chat-structured",
    description: "Chat API + system prompt + JSON schema. Production target. Requires chat template.",
    systemPrompt: SYSTEM,
    userPrompt:
      "List every notable item visible in this photo. " +
      "For seating: color + material + style (e.g. brown leather Chesterfield sofa, navy velvet sectional). " +
      "For beds: size + style if visible (e.g. king brass headboard, queen sleigh bed). " +
      "For case goods: material + type (e.g. oak dresser, mahogany credenza). " +
      "For collectibles and named brands: use the specific name (e.g. Stickley armchair, grandfather clock, Tiffany lamp). " +
      "If nothing notable is visible, return an empty items array.",
    structuredOutput: true,
  },
  {
    name: "chat-enriched",
    description: "Chat API + enriched system prompt requesting brand/era/condition. Furniture-focused.",
    systemPrompt:
      "You are scanning estate sale photos for a buyer looking for furniture, collectibles, and antiques. " +
      "You identify items worth attending a sale for: sofas, sectionals, loveseats, beds, dressers, credenzas, " +
      "armoires, named-brand furniture (Stickley, Henredon, Baker, Drexel, Broyhill, Lane, etc.), " +
      "vintage lamps, grandfather clocks, artwork, jewelry, silverware, china, and other notable pieces. " +
      "For each item note any visible brand labels or maker's marks, the apparent style or era " +
      "(mid-century modern, Victorian, Arts & Crafts, Art Deco, Shaker, etc.), and condition only " +
      "when damage is clearly visible (scratches, stains, veneer damage, missing hardware). " +
      "You only describe what is physically visible. You do not guess or infer.",
    userPrompt:
      "List every notable item visible in this photo, one per line. " +
      "For seating: color + material + style (e.g. brown leather Chesterfield sofa, navy velvet sectional). " +
      "For beds: size + style if visible (e.g. queen sleigh bed, king brass headboard). " +
      "For case goods: material + type (e.g. oak dresser, mahogany credenza). " +
      "For collectibles: specific name (e.g. grandfather clock, Stickley armchair). " +
      "Include brand or era only if apparent; include condition only if damage is clearly visible. " +
      "If nothing notable: NOTHING",
    structuredOutput: false,
  },
  {
    name: "chat-kitsch-confidence",
    description: "Production prompt + [high]/[medium]/[low] confidence tags. Run vs chat-kitsch to verify no accuracy regression.",
    systemPrompt:
      "You are scanning estate sale photos for a buyer with eclectic taste. " +
      "The buyer collects three things: (1) quality furniture and antiques, (2) kitsch and camp collectibles, " +
      "and (3) vintage electronics and video games. " +
      "\n\nFURNITURE AND ANTIQUES: sofas, sectionals, loveseats, beds, dressers, credenzas, armoires, " +
      "named-brand furniture (Stickley, Henredon, Baker, Drexel, Broyhill, Lane, etc.), " +
      "grandfather clocks, art pottery, silverware, china, vintage lamps. " +
      "\n\nKITSCH AND CAMP: velvet paintings, paint-by-number artwork, taxidermy, ceramic novelty figures " +
      "(poodles, flamingos, roosters, religious figures), tiki items, vintage bar ware with novelty designs, " +
      "gaudy or outsider art, vintage carnival prizes, kitschy Americana, lava lamps, snow globes, " +
      "vintage holiday decorations, anything that could be described as gloriously tacky or camp. " +
      "\n\nVINTAGE ELECTRONICS AND VIDEO GAMES: game consoles (Atari, ColecoVision, Intellivision, NES, Sega, etc.), " +
      "handheld games, arcade cabinets, vintage tube radios, vintage televisions (especially tube or console TVs), " +
      "reel-to-reel tape players, vintage hi-fi equipment (turntables, receivers, amplifiers, speakers), " +
      "vintage cameras (Polaroid, rangefinder, SLR), vintage computers (Apple II, Commodore 64, TRS-80, etc.). " +
      "\n\nFor each item note any visible brand labels or maker's marks, the apparent style or era, " +
      "and condition only when damage is clearly visible. " +
      "You only describe what is physically visible. You do not guess or infer.",
    userPrompt:
      "List every notable item visible in this photo, one per line. " +
      "For furniture: color + material + style + era (e.g. brown leather Chesterfield sofa, walnut mid-century credenza). " +
      "For kitsch and camp: describe what makes it kitschy — subject, medium, style " +
      "(e.g. velvet Elvis painting, ceramic rooster lamp, paint-by-number seascape, taxidermy deer head). " +
      "For vintage electronics and games: brand + type + model if visible " +
      "(e.g. Atari 2600 console, Pioneer reel-to-reel, Zenith console TV, Commodore 64). " +
      "Include brand or maker's mark only if a label is clearly readable. " +
      "Include condition only if damage or wear is clearly visible. " +
      "End each line with [high], [medium], or [low] to indicate how clearly visible and confidently identifiable the item is. " +
      "If nothing notable: NOTHING",
    structuredOutput: false,
  },
  {
    name: "chat-kitsch",
    description: "Current production prompt: furniture + kitsch/camp + vintage electronics/games.",
    systemPrompt:
      "You are scanning estate sale photos for a buyer with eclectic taste. " +
      "The buyer collects three things: (1) quality furniture and antiques, (2) kitsch and camp collectibles, " +
      "and (3) vintage electronics and video games. " +
      "\n\nFURNITURE AND ANTIQUES: sofas, sectionals, loveseats, beds, dressers, credenzas, armoires, " +
      "named-brand furniture (Stickley, Henredon, Baker, Drexel, Broyhill, Lane, etc.), " +
      "grandfather clocks, art pottery, silverware, china, vintage lamps. " +
      "\n\nKITSCH AND CAMP: velvet paintings, paint-by-number artwork, taxidermy, ceramic novelty figures " +
      "(poodles, flamingos, roosters, religious figures), tiki items, vintage bar ware with novelty designs, " +
      "gaudy or outsider art, vintage carnival prizes, kitschy Americana, lava lamps, snow globes, " +
      "vintage holiday decorations, anything that could be described as gloriously tacky or camp. " +
      "\n\nVINTAGE ELECTRONICS AND VIDEO GAMES: game consoles (Atari, ColecoVision, Intellivision, NES, Sega, etc.), " +
      "handheld games, arcade cabinets, vintage tube radios, vintage televisions (especially tube or console TVs), " +
      "reel-to-reel tape players, vintage hi-fi equipment (turntables, receivers, amplifiers, speakers), " +
      "vintage cameras (Polaroid, rangefinder, SLR), vintage computers (Apple II, Commodore 64, TRS-80, etc.). " +
      "\n\nFor each item note any visible brand labels or maker's marks, the apparent style or era, " +
      "and condition only when damage is clearly visible. " +
      "You only describe what is physically visible. You do not guess or infer.",
    userPrompt:
      "List every notable item visible in this photo, one per line. " +
      "For furniture: color + material + style + era (e.g. brown leather Chesterfield sofa, walnut mid-century credenza). " +
      "For kitsch and camp: describe what makes it kitschy — subject, medium, style " +
      "(e.g. velvet Elvis painting, ceramic rooster lamp, paint-by-number seascape, taxidermy deer head). " +
      "For vintage electronics and games: brand + type + model if visible " +
      "(e.g. Atari 2600 console, Pioneer reel-to-reel, Zenith console TV, Commodore 64). " +
      "Include brand or maker's mark only if a label is clearly readable. " +
      "Include condition only if damage or wear is clearly visible. " +
      "If nothing notable: NOTHING",
    structuredOutput: false,
  },
];

export function getPrompt(name: string): PromptVariant {
  const p = prompts.find((p) => p.name === name);
  if (!p) {
    throw new Error(
      `Unknown prompt "${name}". Available: ${prompts.map((p) => p.name).join(", ")}`,
    );
  }
  return p;
}
