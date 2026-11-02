import { db } from "../../db";
import { sql } from "drizzle-orm";
export type StockTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

function retryable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const item = error as { code?: string; cause?: unknown };
  return item.code === "40P01" || item.code === "40001" || (!!item.cause && retryable(item.cause));
}

/** Stock operations may run together; reconciliation gets an exclusive barrier. */
export async function stockTransaction<T>(work: (tx: StockTransaction) => Promise<T>, exclusive = false): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.transaction(async (tx) => {
        await tx.execute(exclusive ? sql`select pg_advisory_xact_lock(721002)` : sql`select pg_advisory_xact_lock_shared(721002)`);
        return work(tx);
      });
    } catch (error) {
      if (!retryable(error) || attempt >= 2) throw error;
      await Bun.sleep(20 * (attempt + 1) + Math.random() * 30);
    }
  }
}
