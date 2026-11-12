import { and, asc, eq, isNotNull, lte, sql } from "drizzle-orm";
import { db } from "../../db";
import { archives, audit_logs } from "../../db/schema";
import { stockTransaction, type StockTransaction } from "../inventory/transaction";
import { lifecycleTables, type LifecycleResource } from "../lifecycle/service";
import { lockUserMutation, type MutationActor } from "../user/mutation-policy";
import { WorkflowError } from "../../utils/workflow-error";
import { logger } from "../../utils/logger";

export const RETENTION_SECONDS = 30 * 24 * 60 * 60;
export function isLifecycleResource(value: string): value is LifecycleResource {
  return Object.hasOwn(lifecycleTables, value);
}
async function databaseTime(tx: StockTransaction) {
  const [row] = await tx.execute<{ now: number }>(sql`select floor(extract(epoch from clock_timestamp()))::integer as now`);
  return Number(row!.now);
}

export async function scheduleArchiveDeletion(id: number, actor: MutationActor) {
  return stockTransaction(async (tx) => {
    await lockUserMutation(tx, actor);
    const [archive] = await tx.select().from(archives).where(eq(archives.id, id)).for("update");
    if (!archive || !isLifecycleResource(archive.entity_type)) throw new WorkflowError("Archived record not found.", 404);
    const table = lifecycleTables[archive.entity_type];
    const [record] = await tx.select().from(table).where(and(eq(table.id, Number(archive.entity_id)), eq(table.is_archived, true))).for("update");
    if (!record) throw new WorkflowError("The record is no longer archived. Refresh the list.");
    if (archive.delete_after !== null) return { message: "Deletion is already scheduled.", delete_after: archive.delete_after };
    const now = Math.max(await databaseTime(tx), archive.archived_at);
    const deleteAfter = now + RETENTION_SECONDS;
    await tx.update(archives).set({ deletion_requested_at: now, delete_after: deleteAfter, deletion_error: null }).where(eq(archives.id, id));
    await tx.insert(audit_logs).values({ user_id: actor.id, action: "ARCHIVE_DELETION_SCHEDULED", entity_type: archive.entity_type,
      entity_id: archive.entity_id, description: "Permanent deletion scheduled after 30 days in Archives.", old_value: "{}",
      new_value: JSON.stringify({ delete_after: deleteAfter }), metadata: JSON.stringify({ archive_id: id }),
      ip_address: "unknown", user_agent: "unknown", created_at: now });
    return { message: "Deletion scheduled. The record will remain in Archives for 30 days; linked history may prevent deletion.", delete_after: deleteAfter };
  }, true);
}

type Reference = { schema_name: string; table_name: string; column_name: string; key_count: number };
type PlannedRow = { schema: string; table: string; id: number };
// Only these children are owned by the entity. All other references, including
// CASCADE and SET NULL foreign keys, block deletion instead of erasing history.
const owned: Record<string, readonly string[]> = {
  products: ["product_variants.product_id"],
  users: ["customers.user_id", "drivers.user_id", "staffs.user_id"],
  customers: ["customer_addresses.customer_id"],
};
const referenceLabels: Record<string, string> = {
  inventory: "inventory records", order_items: "order history", orders: "orders", deliveries: "delivery history",
  stock_movements: "stock movement history", audit_logs: "audit history", vehicle_positions: "vehicle location history",
  customer_returns: "customer returns", archives: "other archived records", notifications: "notifications", ws_logs: "session history",
  drivers: "driver assignments", staffs: "staff assignments", vehicles: "vehicles", customers: "customer accounts",
};

async function planDeletion(tx: StockTransaction, schemaName: string, tableName: string, id: number,
  plan: PlannedRow[], blockers: Set<string>, visited = new Set<string>()) {
  const key = `${schemaName}.${tableName}:${id}`;
  if (visited.has(key)) return;
  visited.add(key);
  const references = await tx.execute<Reference>(sql`
    select ns.nspname as schema_name, child.relname as table_name, attr.attname as column_name,
           cardinality(fk.conkey)::integer as key_count
    from pg_constraint fk
    join pg_class parent on parent.oid = fk.confrelid
    join pg_namespace parent_ns on parent_ns.oid = parent.relnamespace
    join pg_class child on child.oid = fk.conrelid
    join pg_namespace ns on ns.oid = child.relnamespace
    join pg_attribute attr on attr.attrelid = child.oid and attr.attnum = fk.conkey[1]
    where fk.contype = 'f' and parent.relname = ${tableName} and parent_ns.nspname = ${schemaName}
    order by ns.nspname, child.relname, attr.attname`);
  for (const reference of references) {
    if (reference.key_count !== 1) { blockers.add("linked records with a complex relationship"); continue; }
    const childTable = sql`${sql.identifier(reference.schema_name)}.${sql.identifier(reference.table_name)}`;
    const childColumn = sql.identifier(reference.column_name);
    const isOwned = reference.schema_name === schemaName && owned[tableName]?.includes(`${reference.table_name}.${reference.column_name}`);
    if (isOwned) {
      const children = await tx.execute<{ id: number }>(sql`select id from ${childTable} where ${childColumn} = ${id} order by id for update`);
      for (const child of children) await planDeletion(tx, reference.schema_name, reference.table_name, child.id, plan, blockers, visited);
    } else {
      const [found] = await tx.execute(sql`select 1 from ${childTable} where ${childColumn} = ${id} limit 1`);
      if (found) blockers.add(referenceLabels[reference.table_name] ?? "linked records");
    }
  }
  plan.push({ schema: schemaName, table: tableName, id });
}

/** No HTTP endpoint can directly purge a record. The worker rechecks DB time. */
export async function purgeDueArchive(id: number) {
  return stockTransaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(721001)`);
    const [archive] = await tx.select().from(archives).where(eq(archives.id, id)).for("update");
    const now = await databaseTime(tx);
    if (!archive || archive.delete_after === null || archive.deletion_requested_at === null ||
      now < archive.delete_after || now < archive.deletion_requested_at + RETENTION_SECONDS || now < archive.archived_at + RETENTION_SECONDS) return { deleted: false };
    if (!isLifecycleResource(archive.entity_type)) return { deleted: false };
    const table = lifecycleTables[archive.entity_type];
    const [record] = await tx.select().from(table).where(eq(table.id, Number(archive.entity_id))).for("update");
    if (!record || !record.is_archived) {
      await tx.update(archives).set({ deletion_error: "The entity is missing or no longer archived; deletion was stopped.", deletion_last_attempt_at: now }).where(eq(archives.id, id));
      return { deleted: false };
    }
    if (record.archived_at === null || archive.deletion_requested_at < record.archived_at || now < record.archived_at + RETENTION_SECONDS) {
      await tx.update(archives).set({ deletion_error: "The archive date changed. The record is retained until its retention period is satisfied.", deletion_last_attempt_at: now }).where(eq(archives.id, id));
      return { deleted: false };
    }
    const blockers = new Set<string>();
    if (archive.entity_type === "inventory" && "quantity" in record && (record.quantity !== 0 || record.reserved !== 0)) blockers.add("non-zero stock or reservations");
    const plan: PlannedRow[] = [];
    // The target and owned children are locked FOR UPDATE before checking their
    // references. Concurrent FK inserts cannot slip between the check and delete.
    await planDeletion(tx, "public", archive.entity_type, record.id, plan, blockers);
    if (blockers.size) {
      await tx.update(archives).set({ deletion_last_attempt_at: now,
        deletion_error: `Deletion blocked by ${[...blockers].sort().join(", ")}. Linked records and stock are retained; cleanup will retry.` }).where(eq(archives.id, id));
      return { deleted: false };
    }
    await tx.insert(audit_logs).values({ user_id: archive.archived_by, action: "ARCHIVE_PERMANENTLY_DELETED", entity_type: archive.entity_type,
      entity_id: archive.entity_id, description: `Permanently deleted archived ${archive.entity_type} ${archive.entity_id} after retention.`,
      old_value: JSON.stringify({ id: record.id, is_archived: true }), new_value: "{}",
      metadata: JSON.stringify({ archive_id: id, delete_after: archive.delete_after, deletion_requested_at: archive.deletion_requested_at }),
      ip_address: "system", user_agent: "archive-retention-worker", created_at: now });
    for (const item of plan) await tx.execute(sql`delete from ${sql.identifier(item.schema)}.${sql.identifier(item.table)} where id = ${item.id}`);
    await tx.delete(archives).where(eq(archives.id, id));
    return { deleted: true, resource: archive.entity_type };
  }, true);
}

export async function sweepArchiveRetention() {
  const due = await db.select({ id: archives.id }).from(archives).where(and(isNotNull(archives.delete_after),
    lte(archives.delete_after, sql`floor(extract(epoch from clock_timestamp()))::integer`)))
    .orderBy(sql`${archives.deletion_last_attempt_at} asc nulls first`, asc(archives.delete_after), asc(archives.id)).limit(25);
  let deleted = 0;
  for (const item of due) {
    try {
      const result = await purgeDueArchive(item.id);
      if (result.deleted) deleted++;
      // Notifications are delivered only after the mutation transaction commits.
      for (const resource of new Set(["archives", ...(result.deleted && result.resource ? [result.resource] : [])])) {
        await db.execute(sql`select pg_notify('hyops_resource_changed', ${JSON.stringify({ type: "RESOURCE_CHANGED", payload: { resource, eventId: crypto.randomUUID() } })})`);
      }
    } catch (error) {
      logger.error(`Archive retention failed for archive ${item.id}: ${error instanceof Error ? error.message : "Unknown error"}`);
      // Keep the record and retry after transient errors; never bypass constraints.
      await db.update(archives).set({ deletion_error: "Automatic cleanup could not complete. The record is retained and cleanup will retry.",
        deletion_last_attempt_at: sql`floor(extract(epoch from clock_timestamp()))::integer` }).where(eq(archives.id, item.id));
    }
  }
  return { checked: due.length, deleted };
}

export function startArchiveRetentionWorker() {
  let running: Promise<unknown> | undefined;
  const tick = () => {
    if (!running) running = sweepArchiveRetention().catch((error) => logger.error(`Archive retention sweep failed: ${error instanceof Error ? error.message : "Unknown error"}`)).finally(() => { running = undefined; });
  };
  tick();
  const timer = setInterval(tick, 60_000);
  timer.unref?.();
  return { stop: async () => { clearInterval(timer); await running; } };
}
