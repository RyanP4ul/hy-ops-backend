import { WorkflowError } from "../../utils/workflow-error";
import { db } from "@/db/index";
import { warehouses } from "@/db/schema/warehouses";
import { and, count, desc, asc, eq, ilike, or } from "drizzle-orm";
import { logger } from "../../utils/logger";
import {
  archives,
  inventory,
  vehicles,
  drivers,
  staffs,
  orders,
} from "@/db/schema";
import { inArray } from "drizzle-orm";
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
    const offset = Math.max(page * limit, 0);
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
          phone_number: warehouses.phone_number,
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
    const offset = Math.max(page * limit, 0);
    const is_archived_query = eq(warehouses.is_archived, false);

    const whereQuery = !is_search_empty
      ? and(ilike(warehouses.name, `%${search}%`), is_archived_query)
      : is_archived_query;

    const total_page = await db.query.warehouses.findMany({
      columns: {
        id: true,
      },
      where: whereQuery,
    });

    const warehouseNames = await db.query.warehouses.findMany({
      columns: {
        id: true,
        name: true,
        phone_number: true,
        street_address: true,
        city: true,
        state: true,
        zip_code: true,
        latitude: true,
        longitude: true,
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
    if ((data.latitude === undefined) !== (data.longitude === undefined))
      throw new WorkflowError(
        "Enter both latitude and longitude, or leave both blank.",
        400,
      );
    return await db.transaction(async (tx) => {
      const errors: Record<string, string> = {};

      if (await this.doesWarehouseExistByName(data.name)) {
        errors.name = "Warehouse with this name already exists";
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
          latitude: data.clear_coordinates
            ? null
            : data.latitude === undefined
              ? undefined
              : String(data.latitude),
          longitude: data.clear_coordinates
            ? null
            : data.longitude === undefined
              ? undefined
              : String(data.longitude),
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
      if ((data.latitude === undefined) !== (data.longitude === undefined))
        throw new WorkflowError(
          "Enter both latitude and longitude, or leave both blank.",
          400,
        );
      const errors: Record<string, string> = {};

      const existing_warehouse = await tx.query.warehouses.findFirst({
        where: and(eq(warehouses.id, id), eq(warehouses.is_archived, false)),
      });

      if (!existing_warehouse) {
        throw new WorkflowError("Warehouse not found", 404);
      }

      if (existing_warehouse.version !== data.version) {
        throw new WorkflowError(
          "Version mismatch. Please refresh and try again.",
        );
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
        .set({
          ...data,
          latitude: data.clear_coordinates
            ? null
            : data.latitude === undefined
              ? undefined
              : String(data.latitude),
          longitude: data.clear_coordinates
            ? null
            : data.longitude === undefined
              ? undefined
              : String(data.longitude),
          version: data.version + 1,
          updated_at: Math.floor(Date.now() / 1000),
        })
        .where(and(eq(warehouses.id, id), eq(warehouses.version, data.version)))
        .returning({
          id: warehouses.id,
          name: warehouses.name,
          street_address: warehouses.street_address,
          phone_number: warehouses.phone_number,
          city: warehouses.city,
          state: warehouses.state,
          zip_code: warehouses.zip_code,
          version: warehouses.version,
        });

      if (!warehouse)
        throw new WorkflowError("Warehouse changed. Refresh before retrying.");

      return {
        data: warehouse,
        message: "Warehouse updated successfully",
      };
    });
  }

  static async deleteWarehouse(id: number, version: number) {
    return db.transaction(async (tx) => {
      const [warehouse] = await tx
        .select()
        .from(warehouses)
        .where(and(eq(warehouses.id, id), eq(warehouses.is_archived, false)))
        .for("update");
      if (!warehouse || warehouse.version !== version)
        throw new WorkflowError(
          "Warehouse changed or was removed. Refresh before retrying.",
        );
      const references = await Promise.all([
        tx
          .select({ id: inventory.id })
          .from(inventory)
          .where(eq(inventory.warehouse_id, id))
          .limit(1),
        tx
          .select({ id: vehicles.id })
          .from(vehicles)
          .where(eq(vehicles.warehouse_id, id))
          .limit(1),
        tx
          .select({ id: drivers.id })
          .from(drivers)
          .where(eq(drivers.warehouse_id, id))
          .limit(1),
        tx
          .select({ id: staffs.id })
          .from(staffs)
          .where(eq(staffs.warehouse_id, id))
          .limit(1),
        tx
          .select({ id: orders.id })
          .from(orders)
          .where(or(eq(orders.warehouse_id, id), eq(orders.lalamove_pickup_warehouse_id, id)))
          .limit(1),
      ]);
      if (references.some((rows) => rows.length))
        throw new WorkflowError(
          "Warehouse has linked stock, people, vehicles or orders. Archive it to retain history.",
        );
      await tx.delete(warehouses).where(eq(warehouses.id, id));
      return { message: "Warehouse deleted." };
    });
  }

  static async archiveWarehouse(
    user_id: number,
    warehouse_id: number,
    version: number,
  ) {
    return db.transaction(async (tx) => {
      const [warehouse] = await tx
        .select()
        .from(warehouses)
        .where(
          and(
            eq(warehouses.id, warehouse_id),
            eq(warehouses.is_archived, false),
          ),
        )
        .for("update");
      if (!warehouse || warehouse.version !== version)
        throw new WorkflowError(
          "Warehouse changed or was archived. Refresh before retrying.",
        );
      const [active] = await tx
        .select({ id: orders.id })
        .from(orders)
        .where(
          and(
            or(eq(orders.warehouse_id, warehouse_id), eq(orders.lalamove_pickup_warehouse_id, warehouse_id)),
            inArray(orders.status, [
              "PENDING",
              "PROCESSING",
              "SCHEDULING",
              "SCHEDULED",
              "IN_TRANSIT",
            ]),
          ),
        )
        .limit(1);
      if (active)
        throw new WorkflowError(
          "Complete or cancel the warehouse's active orders before archiving.",
        );
      const now = Math.floor(Date.now() / 1000);
      await tx
        .update(warehouses)
        .set({
          is_archived: true,
          archived_at: now,
          updated_at: now,
          version: warehouse.version + 1,
        })
        .where(eq(warehouses.id, warehouse_id));
      const [archive] = await tx
        .insert(archives)
        .values({
          entity_id: String(warehouse_id),
          entity_type: "warehouses",
          archived_by: user_id,
          archived_at: now,
        })
        .returning({ id: archives.id });
      return {
        id: archive?.id,
        message: "Warehouse archived; history retained.",
      };
    });
  }
}

export const warehouseService = WarehouseService;
