import { blob, index, integer, real, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

export const sales = sqliteTable("sales", {
  saleId: text("sale_id").primaryKey(),
  title: text("title").notNull(),
  url: text("url").notNull(),
  startDate: text("start_date").notNull(),
  endDate: text("end_date").notNull(),
  address: text("address").notNull(),
  city: text("city").notNull(),
  state: text("state").notNull(),
  zip: text("zip").notNull(),
  lat: real("lat").notNull(),
  lon: real("lon").notNull(),
  distanceMiles: real("distance_miles").notNull(),
  scrapedAt: text("scraped_at").notNull(),
  // Phase tracking
  imageCount: integer("image_count"),
  imagesAnalyzed: integer("images_analyzed"),
  analysisPhase: text("analysis_phase"), // "FULL" | "TAIL_PROBE" | "EARLY_STOP"
  // Oracle escalation result
  oracleScore: real("oracle_score"),
  oracleVerdict: text("oracle_verdict"),
  oracleShouldAttend: integer("oracle_should_attend", { mode: "boolean" }),
  oracleTopItems: text("oracle_top_items"), // JSON array of strings
});

// Every analyzed listing photo — winners AND junk (ADR 0013, 0014).
// Owns the irreplaceable image-level facts that outlive the expired source listing:
// the embedding (frozen model) and the thumbnail. Junk-image rows are the negative
// exemplars the taste ranker trains on; "waste" Outcomes stamp them confirmed-negative.
export const images = sqliteTable("images", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  saleId: text("sale_id")
    .notNull()
    .references(() => sales.saleId),
  imageUrl: text("image_url").notNull(),
  // Durable, irreplaceable (source 404s days after the sale)
  thumbnailPath: text("thumbnail_path"), // NAS file ref — also the re-embed insurance (ADR 0016)
  embedding: blob("embedding", { mode: "buffer" }), // CLIP/SigLIP vector, frozen to one model
  embedModel: text("embed_model"), // generator provenance (ADR 0016) — freeze; change = re-embed migration
  embedDim: integer("embed_dim"),
  // Dedup / hygiene (ADR not yet numbered — Q6 grill): idempotency + boilerplate
  phash: text("phash"), // perceptual hash for cross-sale content dedup
  isBoilerplate: integer("is_boilerplate", { mode: "boolean" }).notNull().default(false), // logo/filler seen in >=5 sales → excluded from training
  positionPct: real("position_pct"), // where in the listing
  analyzedAt: text("analyzed_at").notNull().$defaultFn(() => new Date().toISOString()),
}, (t) => ({
  uniqSaleImageUrl: unique("uniq_images_sale_image_url").on(t.saleId, t.imageUrl), // scan idempotency
  idxSaleId: index("idx_images_sale_id").on(t.saleId),
  idxPhash: index("idx_images_phash").on(t.phash),
}));

export const findings = sqliteTable("findings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  saleId: text("sale_id")
    .notNull()
    .references(() => sales.saleId),
  imageId: integer("image_id").references(() => images.id), // the flagged Image (ADR 0014); nullable until backfilled
  imageUrl: text("image_url").notNull(),
  description: text("description").notNull(),
  scrapedAt: text("scraped_at").notNull(),
  // Instrumentation
  imagePositionPct: real("image_position_pct"),
  confidence: text("confidence"), // "high" | "medium" | "low"
  // Generator provenance (ADR 0016) — VLM + prompt are tuned over time; stamp the seams
  vlmModel: text("vlm_model"),
  promptVersion: text("prompt_version"),
}, (t) => ({
  idxSaleId: index("idx_findings_sale_id").on(t.saleId),
  idxImageId: index("idx_findings_image_id").on(t.imageId),
}));

// One identified object within a Finding (ADR 0011, 0014). One Finding (image) → many Items.
// The normalized, queryable tier for browse-history (B) and future comps joins (C).
export const findingItems = sqliteTable("finding_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  findingId: integer("finding_id")
    .notNull()
    .references(() => findings.id),
  saleId: text("sale_id")
    .notNull()
    .references(() => sales.saleId), // denormalized for cheap browse queries
  maker: text("maker"), // canonical form ONLY (lexicon is sole authority); NULL if unlisted
  makerRaw: text("maker_raw"), // raw model guess — re-mined/backfilled when lexicon grows
  category: text("category").notNull(), // CLOSED VOCAB (~12-15) or "other"
  era: text("era"),
  desirability: text("desirability").notNull(), // "high" | "med" | "low"
  matchedLexicon: text("matched_lexicon", { mode: "json" }).$type<string[]>().notNull().$defaultFn(() => []),
  itemDesc: text("item_desc").notNull(),
  source: text("source").notNull(), // "vlm" | "lexicon" | "human" — provenance; human = gold
  idConfidence: text("id_confidence").notNull(), // "high" | "med" | "low"
  // Generator provenance (ADR 0016)
  vlmModel: text("vlm_model"),
  promptVersion: text("prompt_version"),
}, (t) => ({
  idxFindingId: index("idx_finding_items_finding_id").on(t.findingId),
  idxSaleId: index("idx_finding_items_sale_id").on(t.saleId),
  idxMaker: index("idx_finding_items_maker").on(t.maker),
  idxCategory: index("idx_finding_items_category").on(t.category),
}));

export const saleOutcomes = sqliteTable("sale_outcomes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  saleId: text("sale_id")
    .notNull()
    .references(() => sales.saleId),
  ownerSub: text("owner_sub").notNull(),
  attended: integer("attended", { mode: "boolean" }).notNull(),
  outcome: text("outcome").notNull(), // "good" | "meh" | "waste"
  notes: text("notes"),
  recordedAt: text("recorded_at").notNull(),
}, (t) => ({
  uniqSaleOutcomeOwner: unique("uniq_sale_outcomes_sale_owner").on(t.saleId, t.ownerSub),
}));

export const hunts = sqliteTable("hunts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ownerSub: text("owner_sub").notNull(),
  name: text("name").notNull(),
  keywords: text("keywords", { mode: "json" }).$type<string[]>().notNull(),
  createdAt: text("created_at").notNull(),
}, (t) => ({
  idxOwnerSub: index("idx_hunts_owner_sub").on(t.ownerSub),
}));

export const planItems = sqliteTable("plan_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ownerSub: text("owner_sub").notNull(),
  saleId: text("sale_id")
    .notNull()
    .references(() => sales.saleId),
  sortOrder: integer("sort_order").notNull(),
}, (t) => ({
  idxSaleId: index("idx_plan_items_sale_id").on(t.saleId),
}));

export const userSettings = sqliteTable("user_settings", {
  ownerSub: text("owner_sub").primaryKey(),
  radiusMiles: real("radius_miles").notNull(),
});

export const notifications = sqliteTable("notifications", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ownerSub: text("owner_sub").notNull(),
  channel: text("channel").notNull(), // "email" | "sms" — enforced at app layer
  destination: text("destination").notNull(), // email address or E.164 phone number
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
}, (t) => ({
  uniqOwnerChannelDest: unique().on(t.ownerSub, t.channel, t.destination),
  idxOwnerActive: index("idx_notifications_owner_active").on(t.ownerSub, t.active),
}));
