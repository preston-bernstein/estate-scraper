import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
});

export const hunts = sqliteTable("hunts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ownerSub: text("owner_sub").notNull(),
  name: text("name").notNull(),
  keywords: text("keywords", { mode: "json" }).$type<string[]>().notNull(),
  createdAt: text("created_at").notNull(),
});

export const planItems = sqliteTable("plan_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ownerSub: text("owner_sub").notNull(),
  saleId: text("sale_id")
    .notNull()
    .references(() => sales.saleId),
  sortOrder: integer("sort_order").notNull(),
});

export const userSettings = sqliteTable("user_settings", {
  ownerSub: text("owner_sub").primaryKey(),
  radiusMiles: real("radius_miles").notNull(),
});
