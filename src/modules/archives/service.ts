import { db } from "@/db/index";
import { archives, archivesInsert, archivesSelect } from "@/db/schema/archive";
import { and, eq, count, desc } from "drizzle-orm";
import * as schema from "../../db/schema";
import { getTable, TableName, tables } from "@/db/table";
import { users, warehouses } from "../../db/schema";
import { logger } from "../../utils/logger";
import { UserService } from "../user/service";

export abstract class ArchiveService {
  static async getEntityData(entity_type: TableName, entity_id: number) {
    const entityTable = getTable(entity_type);

    switch (entityTable) {
      case tables.users:
        return await db.query.users.findFirst({
          columns: {
            password: false,
            is_archived: false,
            archived_at: false,
          },
          where: eq(users.id, entity_id),
        });
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
    const offset = Math.max(page * limit, 0);

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

      const user = await UserService.findUserById(String(row.archived_by));

      if (!user) continue;

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

  static async restoreArchive(archive_id: number) {
    const archive = await db.query.archives.findFirst({
      where: eq(archives.id, archive_id),
    });

    if (!archive) {
      throw new Error(`Archive with ID ${archive_id} not found`);
    }

    const entity_table = getTable(archive.entity_type as TableName);

    switch (entity_table) {
      case tables.warehouses:
        return await db.transaction(async (tx) => {
          const existing_warehouse = await tx.query.warehouses.findFirst({
            columns: { version: true },
            where: eq(warehouses.id, Number(archive.entity_id)),
          });

          if (!existing_warehouse) {
            throw new Error(
              `Warehouse with ID ${archive.entity_id} does not exist`,
            );
          }

          const warehouse_result = await tx
            .update(warehouses)
            .set({
              is_archived: false,
              archived_at: null,
              version: existing_warehouse.version + 1,
              updated_at: Math.floor(Date.now() / 1000),
            })
            .where(
              and(
                eq(warehouses.id, Number(archive.entity_id)),
                eq(warehouses.is_archived, true),
              ),
            );

          if (!warehouse_result) {
            throw new Error(
              `Failed to restore warehouse with ID ${archive.entity_id}`,
            );
          }

          const archive_delete_result = await tx
            .delete(archives)
            .where(eq(archives.id, archive_id));

          if (!archive_delete_result) {
            throw new Error(
              `Failed to delete archive with ID ${archive_id} after restoring warehouse`,
            );
          }

          return {
            message: `Successfully restored warehouse with ID ${archive.entity_id}`,
          };
        });
      case tables.users:
        return await db.transaction(async (tx) => {
          const existing_user = await tx.query.users.findFirst({
            columns: { version: true },
            where: eq(users.id, Number(archive.entity_id)),
          });

          if (!existing_user) {
            throw new Error(`User with ID ${archive.entity_id} does not exist`);
          }

          const user_result = await tx
            .update(users)
            .set({
              is_archived: false,
              archived_at: null,
              version: existing_user.version + 1,
              updated_at: Math.floor(Date.now() / 1000),
            })
            .where(
              and(
                eq(users.id, Number(archive.entity_id)),
                eq(users.is_archived, true),
              ),
            );

          if (!user_result) {
            throw new Error(
              `Failed to restore user with ID ${archive.entity_id}`,
            );
          }

          const archive_delete_result = await tx
            .delete(archives)
            .where(eq(archives.id, archive_id));

          if (!archive_delete_result) {
            throw new Error(
              `Failed to delete archive with ID ${archive_id} after restoring user`,
            );
          }

          return {
            message: `Successfully restored user with ID ${archive.entity_id}`,
          };
        });
      default:
        throw new Error(
          `Restore operation not implemented for entity type ${archive.entity_type}`,
        );
    }
  }

  static async doesArchiveExist(archived_id: number) {
    const archive = await db.query.archives.findFirst({
      columns: { id: true },
      where: eq(archives.id, archived_id),
    });
    return archive != undefined;
  }

  static async getArchiveById(archive_id: number) {
    const archive = await db.query.archives.findFirst({
      where: eq(archives.id, archive_id),
    });
    return archive;
  }
}
