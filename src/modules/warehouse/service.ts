import { db } from "@/db/index";
import { warehouses } from "@/db/schema/warehouses";
import { and, count, desc, asc, eq, ilike } from "drizzle-orm";
import { logger } from "../../utils/logger";
import { ArchiveService } from "../archives/service";
import { WarehouseType } from "./model";

type WarehouseSortField = "id" | "name";
type SortOrder = "asc" | "desc";

export abstract class WarehouseService {
  static async getWarehouses(
    page: number = 1,
    limit: number = 10,
    search: string = "",
    sort_by: string = "id:desc",
  ) {
    const is_search_empty = search.length === 0;
    const offset = is_search_empty ? Math.max(page * limit, 0) : 0;
    const [sortField, sortOrder] = sort_by.split(":");

    const is_archived_query = eq(warehouses.is_archived, false);

    const whereQuery = !is_search_empty
      ? and(ilike(warehouses.name, `%${search}%`), is_archived_query)
      : is_archived_query;

    const [totalResult, warehouseNames] = await Promise.all([
      db.select({ count: count() }).from(warehouses).where(whereQuery),
      db
        .select({
          id: warehouses.id,
          name: warehouses.name,
          street_address: warehouses.street_address,
          city: warehouses.city,
          state: warehouses.state,
          zip_code: warehouses.zip_code,
          version: warehouses.version,
          created_at: warehouses.created_at,
          updated_at: warehouses.updated_at,
        })
        .from(warehouses)
        .where(whereQuery)
        .orderBy(
          this.warehouseSortByField(
            sortField as WarehouseSortField,
            sortOrder as SortOrder,
          ),
        )
        .limit(limit)
        .offset(offset),
    ]);

    return {
      rows: warehouseNames,
      total: totalResult[0]?.count ?? 0,
    };
  }

  static warehouseSortByField(field: WarehouseSortField, order: SortOrder) {
    const columnMap = {
      id: warehouses.id,
      name: warehouses.name,
    } as const;

    const column = columnMap[field];

    return order === "asc" ? asc(column) : desc(column);
  }

  static async getWarehouseNames(
    page: number = 1,
    limit: number = 10,
    search: string = "",
  ) {
    const is_search_empty = search.length === 0;
    const offset = is_search_empty ? Math.max(page * limit, 0) : 0;
    const is_archived_query = eq(warehouses.is_archived, false);

    const whereQuery = !is_search_empty
      ? and(ilike(warehouses.name, `%${search}%`), is_archived_query)
      : is_archived_query;

    const total_page = await db.query.warehouses.findMany({
      columns: {
        id: true,
      },
    });

    const warehouseNames = await db.query.warehouses.findMany({
      columns: {
        id: true,
        name: true,
      },
      where: whereQuery,
      limit,
      offset,
    });

    return {
      rows: warehouseNames,
      total: total_page.length,
    };
  }

  static async getWarehouseById(id: number, is_archived: boolean = false) {
    const warehouse = await db.query.warehouses.findFirst({
      where: and(
        eq(warehouses.id, id),
        eq(warehouses.is_archived, is_archived),
      ),
    });
    return warehouse;
  }

  static async doesWarehouseExistByName(name: string) {
    const warehouse = await db.query.warehouses.findFirst({
      where: and(eq(warehouses.name, name), eq(warehouses.is_archived, false)),
    });
    return warehouse !== undefined;
  }

  static async createWarehouse(data: WarehouseType) {
    return await db.transaction(async (tx) => {
      const errors: Record<string, string> = {};

      if (await this.doesWarehouseExistByName(data.name)) {
        errors.name = "Warehouse with this name already exists 123";
      }

      if (Object.keys(errors).length > 0) {
        return {
          errors,
        };
      }

      const now = Math.floor(Date.now() / 1000);

      const [new_warehouse] = await tx
        .insert(warehouses)
        .values({
          ...data,
          created_at: now,
          updated_at: now,
        })
        .returning({
          id: warehouses.id,
          name: warehouses.name,
        });

      if (!new_warehouse) {
        return {
          message: "Failed to create warehouse",
        };
      }

      return {
        id: new_warehouse.id,
        message: `Warehouse ${new_warehouse.name} created successfully`,
      };
    });
  }

  static async updateWarehouse(
    id: number,
    data: WarehouseType & { version: number },
  ) {
    return await db.transaction(async (tx) => {
      const errors: Record<string, string> = {};

      const existing_warehouse = await tx.query.warehouses.findFirst({
        where: and(eq(warehouses.id, id), eq(warehouses.is_archived, false)),
      });

      if (!existing_warehouse) {
        throw new Error("Warehouse not found");
      }

      if (existing_warehouse.version !== data.version) {
        throw new Error("Version mismatch. Please refresh and try again.");
      }

      if (
        existing_warehouse.name !== data.name &&
        (await this.doesWarehouseExistByName(data.name))
      ) {
        logger.info(
          `Warehouse with name ${data.name} already exists ${existing_warehouse.name}`,
        );
        errors.name = "Warehouse with this name already exists";
      }

      if (Object.keys(errors).length > 0) {
        return {
          errors,
        };
      }

      const [warehouse] = await tx
        .update(warehouses)
        .set({ ...data, updated_at: Math.floor(Date.now() / 1000) })
        .where(eq(warehouses.id, id))
        .returning({
          id: warehouses.id,
          name: warehouses.name,
          street_address: warehouses.street_address,
          city: warehouses.city,
          state: warehouses.state,
          zip_code: warehouses.zip_code,
          version: warehouses.version,
        });

      if (!warehouse) {
        return {
          message: "Failed to update warehouse",
        };
      }

      return {
        data: warehouse,
        message: "Warehouse updated successfully",
      };
    });
  }

  static async deleteWarehouse(id: number, version: number) {
    return await db.transaction(async (tx) => {
      const existing_warehouse = await tx.query.warehouses.findFirst({
        where: and(eq(warehouses.id, id), eq(warehouses.is_archived, false)),
      });

      if (!existing_warehouse) {
        throw new Error("Warehouse not found");
      }

      if (existing_warehouse.version !== version) {
        throw new Error("Version mismatch. Please refresh and try again.");
      }

      await tx
        .delete(warehouses)
        .where(and(eq(warehouses.id, id), eq(warehouses.version, version)));

      return {
        message: `Warehouse with ID ${id} deleted successfully`,
      };
    });
  }

  static async archiveWarehouse(
    user_id: number,
    warehouse_id: number,
    version: number,
  ) {
    return await db.transaction(async (tx) => {
      const existing_warehouse = await tx.query.warehouses.findFirst({
        where: eq(warehouses.id, warehouse_id),
      });

      if (!existing_warehouse) {
        throw new Error("Warehouse not found");
      }

      if (existing_warehouse.version !== version) {
        throw new Error("Version mismatch. Please refresh and try again.");
      }

      const result = await tx
        .update(warehouses)
        .set({
          is_archived: true,
          archived_at: Math.floor(Date.now() / 1000),
          updated_at: Math.floor(Date.now() / 1000),
        })
        .where(eq(warehouses.id, warehouse_id));

      if (!result) {
        throw new Error("Failed to archive warehouse");
      }

      const { id: archiveId } = await ArchiveService.createArchive({
        entity_id: String(warehouse_id),
        entity_type: "warehouses",
        archived_by: user_id,
      });

      return {
        id: archiveId,
        message: `Warehouse with ID ${warehouse_id} archived successfully`,
      };
    });
  }
}

export const warehouseService = WarehouseService;
