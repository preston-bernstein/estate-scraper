import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.js";

export const DATABASE_PATH = process.env.DATABASE_URL ?? "./data/estate-scraper.db";

mkdirSync(dirname(DATABASE_PATH), { recursive: true });

const sqlite = new Database(DATABASE_PATH);
export const db = drizzle(sqlite, { schema });

export function runMigrations(migrationsFolder = "./drizzle") {
  migrate(db, { migrationsFolder });
}
