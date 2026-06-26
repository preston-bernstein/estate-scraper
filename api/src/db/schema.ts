import { index, integer, real, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

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
});

export const findings = sqliteTable("findings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  saleId: text("sale_id")
    .notNull()
    .references(() => sales.saleId),
  imageUrl: text("image_url").notNull(),
  description: text("description").notNull(),
  scrapedAt: text("scraped_at").notNull(),
}, (t) => ({
  idxSaleId: index("idx_findings_sale_id").on(t.saleId),
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
