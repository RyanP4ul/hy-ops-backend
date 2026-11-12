import { stockTransaction } from "../inventory/transaction";
import { lifecycleTables, type LifecycleResource } from "../lifecycle/service";
import { db } from "@/db/index";
import { archives, archivesInsert, archivesSelect } from "@/db/schema/archive";
import { and, eq, count, desc, sql } from "drizzle-orm";
import * as schema from "../../db/schema";
import { getTable, TableName, tables } from "@/db/table";
import { users, warehouses, vehicles, products, inventory } from "../../db/schema";
import { logger } from "../../utils/logger";
import { lockUserMutation, UserMutationError, type MutationActor } from "../user/mutation-policy";

export abstract class ArchiveService {
  static async getEntityData(entity_type: TableName, entity_id: number) {
    const entityTable = getTable(entity_type);

    switch (entityTable) {
      case tables.users:
        return await db.query.users.findFirst({
          columns: {
            password_hash: false,
            refresh_token: false,
            token_version: false,
            is_archived: false,
            archived_at: false,
          },
          where: eq(users.id, entity_id),
        });
      case tables.products:
        return db.query.products.findFirst({ where: eq(products.id, entity_id), with: { variants: true } });
      case tables.inventory:
        return db.query.inventory.findFirst({ where: eq(inventory.id, entity_id) });
      case tables.vehicles:
        return db.query.vehicles.findFirst({ where: eq(vehicles.id, entity_id) });
      case tables.warehouses:
        return await db.query.warehouses.findFirst({
          columns: {
            is_archived: false,
            archived_at: false,
          },
          where: eq(warehouses.id, entity_id),
        });
    }

    return null;
  }

  static async getArchives(page: number = 1, limit: number = 10) {
    limit = Math.min(100, Math.max(1, Number.isFinite(limit) ? limit : 10));
    const offset = Math.max((Number.isFinite(page) ? page : 0) * limit, 0);

    const [totalResult, rows] = await Promise.all([
      db.select({ count: count() }).from(archives),
      db
        .select()
        .from(archives)
        .orderBy(desc(archives.archived_at))
        .limit(limit)
        .offset(offset),
    ]);

    const new_rows: (archivesSelect & {
      data: object;
      user: { id: number; name: string };
    })[] = [];

    for (const row of rows) {
      const data = await ArchiveService.getEntityData(
        row.entity_type as TableName,
        Number(row.entity_id),
      );

      if (!data) continue;

      const user = await db.query.users.findFirst({ columns: { id: true, name: true }, where: eq(users.id, row.archived_by) });


      new_rows.push({
        ...row,
        data,
        user: {
          id: user?.id ?? 0,
          name: user?.name ?? "Unknown",
        },
      });
    }

    return {
      rows: new_rows,
      total: totalResult[0]?.count ?? 0,
    };
  }

  static async createArchive(data: Omit<archivesInsert, "archived_at">) {
    return await db.transaction(async (tx) => {
      const [archive] = await tx
        .insert(archives)
        .values({
          ...data,
          archived_at: Math.floor(Date.now() / 1000),
        })
        .returning({
          id: archives.id,
        });

      if (!archive) {
        throw new Error("Failed to create archive");
      }

      return {
        id: archive.id,
        message: `Successfully created archive for entity ${data.entity_type} with ID ${data.entity_id}`,
      };
    });
  }

  static async restoreArchive(archive_id: number, actor: MutationActor) {
    return stockTransaction(async (tx) => {
      await lockUserMutation(tx, actor);
      const [archive] = await tx.select().from(archives).where(eq(archives.id, archive_id)).for("update");
      if (!archive) throw new UserMutationError("Archive not found or already restored.");
      const table = Object.hasOwn(lifecycleTables, archive.entity_type) ? lifecycleTables[archive.entity_type as LifecycleResource] : null;
      if (!table) throw new UserMutationError("Restoration is not supported for this record type.");
      const [restored] = await tx.update(table).set({
        is_archived: false, is_active: false, archived_at: null, version: sql`${table.version} + 1`,
        updated_at: archive.entity_type === "products" ? new Date() : Math.floor(Date.now() / 1000),
      }).where(and(eq(table.id, Number(archive.entity_id)), eq(table.is_archived, true))).returning({ id: table.id });
      if (!restored) throw new UserMutationError("Archived record no longer exists or is already active.");
      await tx.delete(archives).where(eq(archives.id, archive_id));
      return { message: `Successfully restored ${archive.entity_type} record ${archive.entity_id}. Any scheduled deletion was cancelled.` };
    }, true);
  }

  static async doesArchiveExist(archived_id: number) {
    const archive = await db.query.archives.findFirst({
      columns: { id: true },
      where: eq(archives.id, archived_id),
    });
    return archive !== undefined;
  }

  static async getArchiveById(archive_id: number) {
    const archive = await db.query.archives.findFirst({
      where: eq(archives.id, archive_id),
    });
    return archive;
  }
}
