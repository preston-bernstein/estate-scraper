import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { hunts } from "../db/schema.js";

export type HuntRow = typeof hunts.$inferSelect;

export async function listHunts(ownerSub: string): Promise<HuntRow[]> {
  return db.select().from(hunts).where(eq(hunts.ownerSub, ownerSub));
}

export async function createHunt(
  ownerSub: string,
  name: string,
  keywords: string[],
): Promise<HuntRow> {
  const [created] = await db
    .insert(hunts)
    .values({ ownerSub, name, keywords, createdAt: new Date().toISOString() })
    .returning();
  return created!;
}

// Single ownership-checked lookup shared by update/delete so a future change to the
// check (or a bug in it) can't be made in one call site and missed in the other —
// this gate is what stops one user from mutating another's Hunt.
export async function getOwnedHunt(id: number, ownerSub: string): Promise<HuntRow | null> {
  const [existing] = await db.select().from(hunts).where(eq(hunts.id, id));
  if (!existing || existing.ownerSub !== ownerSub) return null;
  return existing;
}

export async function updateHunt(
  id: number,
  updates: Partial<typeof hunts.$inferInsert>,
): Promise<HuntRow> {
  const [updated] = await db.update(hunts).set(updates).where(eq(hunts.id, id)).returning();
  return updated!;
}

export async function deleteHunt(id: number): Promise<void> {
  await db.delete(hunts).where(eq(hunts.id, id));
}
