export const OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://localhost:11436";
export const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "qwen3-vl:30b";

// Generator provenance (ADR 0016). Bump PROMPT_VERSION whenever VISION_USER_PROMPT
// or VISION_SYSTEM_PROMPT changes meaning, so findings/items carry the seam.
export const PROMPT_VERSION = "selective-v3";

// The VLM that actually ran: managed API model when VISION_API_BASE is configured,
// otherwise the local Ollama model. Stamped on findings + finding_items.
export function activeVlmModel(): string {
  return VISION_API_BASE ? VISION_API_MODEL : OLLAMA_MODEL;
}
export const VISION_WORKERS = 2;
export const PREFILTER_WORKERS = 4;
export const PHASH_HAMMING_THRESHOLD = 10;

// Ollama's /api/chat separates chain-of-thought into a `thinking` field, but a
// reasoning-tuned model (qwen3-vl) still spends its num_predict budget getting
// THROUGH that reasoning before it can emit the actual PASS/SKIP word into
// `content` — at num_predict:10, `content` came back empty on every single call
// (verified against production images), so the gate silently passed everything,
// every time, since empty-string never equals "SKIP" (fail-open by construction).
// 150 is the smallest budget observed to reliably let the model finish reasoning
// and answer; below it, this gate is a no-op. This trades real latency (10-20s of
// local GPU time per image) for real Gemini cost savings — it's the local
// hardware, not a per-call bill, that pays for a bigger budget.
export const LOCAL_GATE_MAX_TOKENS = process.env.LOCAL_GATE_MAX_TOKENS
  ? Number(process.env.LOCAL_GATE_MAX_TOKENS)
  : 150;

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

// runVisionManaged's per-call HTTP timeout. Gemini answers in a few seconds, but a
// RunPod serverless worker that has scaled to zero can take several minutes to cold
// start before it even begins inference (497s observed against Qwen3-VL-32B-Instruct-
// FP8 in calibration) — the old 120s default aborted the client side before RunPod's
// own cold start finished, guaranteeing an error on the first call after any idle
// gap. 600s gives real cold-start headroom without materially changing behavior
// against a fast managed backend like Gemini.
export const VISION_API_TIMEOUT_MS = process.env.VISION_API_TIMEOUT_MS
  ? Number(process.env.VISION_API_TIMEOUT_MS)
  : 600_000;

// The local gate (runLocalGate) is a free GPU-model pre-filter (own hardware, no
// per-call API cost) that screens out obvious non-candidates — exteriors, empty
// rooms, price boards, HVAC/electrical panels, vehicles, boxes-only shots — before
// an image reaches the paid vision backend. It fails open (network error / bad
// response -> PASS) so an Ollama outage never suppresses findings, only costs more
// by sending everything through. Enabled by default: without it, every quality-
// passing image (including trivial non-candidates) is billed to the paid vision
// backend, and roughly half of those calls return nothing (paid for a null result).
// Set LOCAL_GATE_ENABLED=false to bypass it (e.g. no local Ollama available).
export const LOCAL_GATE_ENABLED = process.env.LOCAL_GATE_ENABLED !== "false";

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
  "Be selective — this buyer wants quality, not quantity. Skip everyday junk with no resale " +
  "value: mass-market flat-pack/particle-board furniture, generic decor, plastic storage bins, " +
  "cables and chargers, ordinary clothing, and visibly broken items. " +
  "For each item worth listing, identify it as specifically as you can: the likely maker or brand, " +
  "model or pattern, style and era, materials, and a brief quality/condition read. Infer maker and " +
  "era from design cues even without a readable label, but make clear when it is inferred versus " +
  "confirmed by a visible mark. Never invent items that are not physically in the photo.";

// User turn — enriched format requesting brand/era/condition alongside color+material.
// chat-plain scored 89% detection + 100% specificity in eval; structured output scored only 50%.
// Confidence tags ([high]/[medium]/[low]) appended per line; plain-text outperforms JSON constraint.
export const VISION_USER_PROMPT =
  "List only the items in this photo with genuine resale value to this buyer, one per line. " +
  "Skip everyday junk — mass-market decor, plastic storage, cables, ordinary clothing, flat-pack or " +
  "damaged particle-board furniture, boxes. If nothing in the photo is worth reselling, reply with " +
  "exactly: NOTHING. " +
  "For each item, be as specific as the image allows — likely maker/brand, model or pattern, style, " +
  "era, materials, and a short quality/condition read " +
  "(e.g. 'Stickley-style quartersawn oak Morris chair, Arts & Crafts era, solid, good condition'; " +
  "'walnut mid-century credenza, tapered legs, minor top wear'; " +
  "'Atari 2600 6-switch console, early 1980s, cosmetically worn'). " +
  "Infer maker and era from design cues even without a readable label, noting when it is inferred. " +
  "End each line with [high], [medium], or [low] for your confidence in the identification. " +
  "If nothing of value: NOTHING\n\n" +
  "Many estate sale photos are wide shots of a full room, not close-ups of a single item — a wide " +
  "room shot with a sofa, a coffee table, and framed wall art contains THREE listable items, not zero. " +
  "Scan the whole frame systematically (seating, then tables, then wall décor, then smaller objects on " +
  "surfaces) and list each distinct piece you can identify, even in a busy or professionally " +
  "staged-looking room. A photo that looks like a furniture showroom is still inventory for sale.";

