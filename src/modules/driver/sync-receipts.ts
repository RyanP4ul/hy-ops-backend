import { and, eq, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db } from "../../db";
import { driver_sync_receipts } from "../../db/schema";
import { WorkflowError } from "../../utils/workflow-error";
import { settingService, MOBILE_OFFLINE_WRITES_SETTING } from "../settings/service";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function syncCapabilities() {
  const rows = await db.execute(sql`select to_regclass('public.driver_sync_receipts') is not null as ready`);
  const [setting] = await settingService.getSettingByNames([MOBILE_OFFLINE_WRITES_SETTING]);
  return { protocol: rows[0]?.ready === true ? 1 : 0,
    acceptNewCommands: setting?.value === "true",
    offlineWriteMaxAgeHours: 24 };
}

export function commandHash(kind: string, target: number, payload: Record<string, unknown>) {
  const sorted = Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b)));
  return createHash("sha256").update(JSON.stringify([kind, target, sorted])).digest("hex");
}

// Take the operation lock before entity locks, including across different command kinds.
export async function replayReceipt(tx: Tx, actorId: number, key: string, hash: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
  const [prior] = await tx.select().from(driver_sync_receipts).where(eq(driver_sync_receipts.operation_key, key));
  if (!prior) return undefined;
  if (prior.actor_id !== actorId) throw new WorkflowError("Assignment not found.", 404);
  if (prior.request_hash !== hash)
    throw new WorkflowError("Operation key was already used for different details.", 409, "OPERATION_KEY_REUSED");
  return prior.result;
}

export async function saveReceipt(tx: Tx, actorId: number, key: string, hash: string, result: Record<string, unknown>) {
  await tx.insert(driver_sync_receipts).values({ operation_key: key, actor_id: actorId, request_hash: hash, result });
  return result;
}

export async function operationReceipt(actorId: number, key: string) {
  const [prior] = await db.select({ result: driver_sync_receipts.result }).from(driver_sync_receipts)
    .where(and(eq(driver_sync_receipts.operation_key, key), eq(driver_sync_receipts.actor_id, actorId)));
  // The same response for an unknown key and somebody else's key.
  return { accepted: !!prior, result: prior?.result ?? null };
}
