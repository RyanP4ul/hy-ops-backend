import { stockTransaction } from "../inventory/transaction";
import { activeWarehouse, activeVehicle } from "../lifecycle/availability";
import { db } from "@/db/index";
import { vehicles } from "@/db/schema/vehicles";
import { and, asc, count, desc, eq, ilike, inArray, sql } from "drizzle-orm";
import { VehicleType, VehicleCreateType } from "./model";
import { warehouses } from "@/db/schema/warehouses";

import { deliveries } from "@/db/schema/deliveries";
import { WorkflowError } from "../../utils/workflow-error";

type VehicleSortField = "id" | "plate_number" | "status" | "type";
type SortOrder = "asc" | "desc";

export abstract class VehicleService {
  static async getVehicleTableRowById(id: number) {
    return this.getVehicleById(id);
  }

  static async getVehicles(
    page = 0,
    limit = 10,
    search = "",
    sort_by = "id:desc",
  ) {
    const offset = search.length === 0 ? Math.max(page * limit, 0) : 0;
    const [sortField, sortOrder] = sort_by.split(":");
    const whereQuery = and(eq(vehicles.is_archived, false), search.length ? ilike(vehicles.plate_number, `%${search}%`) : undefined);

    const [totalResult, rows] = await Promise.all([
      db.select({ count: count() }).from(vehicles).where(whereQuery),
      db
        .select({
          id: vehicles.id,
          plate_number: vehicles.plate_number,

          status: vehicles.status,
          type: vehicles.type,
          warehouse_id: vehicles.warehouse_id,
          warehouse_name: warehouses.name,
          version: vehicles.version,
          is_active: vehicles.is_active,
          is_operational: sql<boolean>`${activeVehicle()}`,
        })
        .from(vehicles)
        .leftJoin(warehouses, eq(vehicles.warehouse_id, warehouses.id))
        .where(whereQuery)
        .orderBy(
          this.sortByField(
            sortField as VehicleSortField,
            sortOrder as SortOrder,
          ),
        )
        .limit(limit)
        .offset(offset),
    ]);

    return { rows, total: totalResult[0]?.count ?? 0 };
  }

  static sortByField(field: VehicleSortField, order: SortOrder) {
    const columnMap = {
      id: vehicles.id,
      plate_number: vehicles.plate_number,

      status: vehicles.status,
      type: vehicles.type,
    } as const;
    const column = columnMap[field] ?? vehicles.id;
    return order === "asc" ? asc(column) : desc(column);
  }

  static async getVehicleById(id: number) {
    const [result] = await db
      .select({
        id: vehicles.id,
        plate_number: vehicles.plate_number,

        status: vehicles.status,
        type: vehicles.type,
        warehouse_id: vehicles.warehouse_id,
        warehouse_name: warehouses.name,
        version: vehicles.version,
          is_active: vehicles.is_active,
          is_operational: sql<boolean>`${activeVehicle()}`,
      })
      .from(vehicles)
      .leftJoin(warehouses, eq(vehicles.warehouse_id, warehouses.id))
      .where(and(eq(vehicles.id, id), eq(vehicles.is_archived, false)));

    if (!result) {
      return null;
    }

    return result;
    // return db.query.vehicles.findFirst({ where: eq(vehicles.id, id) });
  }

  static async doesPlateNumberExist(plate_number: string, excludedId?: number) {
    const vehicle = await db.query.vehicles.findFirst({
      where: eq(vehicles.plate_number, plate_number),
    });
    return vehicle !== undefined && vehicle.id !== excludedId;
  }

  static async createVehicle(data: VehicleCreateType) {
    const result = await stockTransaction(async (tx) => {
      data = { ...data, plate_number: data.plate_number.trim().toUpperCase() };
      const warehouse = await tx.query.warehouses.findFirst({ where: and(eq(warehouses.id, data.warehouse_id), activeWarehouse()) });
      if (!warehouse) throw new WorkflowError("Choose an active warehouse.", 400);
      if (await this.doesPlateNumberExist(data.plate_number)) return { errors: { plate_number: "Plate number already exists" } };
      const now = Math.floor(Date.now() / 1000);
      const [vehicle] = await tx.insert(vehicles).values({ warehouse_id: data.warehouse_id, plate_number: data.plate_number, type: data.type, status: "available", created_at: now, updated_at: now })
        .returning({ id: vehicles.id, plate_number: vehicles.plate_number });
      if (!vehicle) throw new WorkflowError("Failed to create vehicle.");
      return vehicle;
    });
    if ("errors" in result) return result;
    return { id: result.id, vehicle: await this.getVehicleTableRowById(result.id), message: `Vehicle ${result.plate_number} created successfully` };
  }

  static async updateVehicle(
    id: number,
    data: VehicleType & { version: number },
  ) {
    return stockTransaction(async (tx) => {
      const [existing] = await tx.select().from(vehicles).where(and(eq(vehicles.id, id), eq(vehicles.is_archived, false))).for("update");
      if (!existing) throw new WorkflowError("Vehicle not found", 404);
      if (existing.version !== data.version) throw new WorkflowError("Version mismatch. Refresh and try again.");
      const [trip] = await tx.select({ id: deliveries.id }).from(deliveries).where(and(eq(deliveries.vehicle_id, id), inArray(deliveries.status, ["scheduled", "in_transit", "returning"])));
      if (trip && (data.status !== existing.status || data.warehouse_id !== existing.warehouse_id || data.type !== existing.type)) throw new WorkflowError("Reassign or complete the vehicle's scheduled/active deliveries before changing status, type or warehouse.");
      if (data.status === "on_delivery" && existing.status !== "on_delivery") throw new WorkflowError("On-delivery status is managed by dispatch.", 400);
      const warehouse = await tx.query.warehouses.findFirst({ where: and(eq(warehouses.id, data.warehouse_id), activeWarehouse()) });
      if (!warehouse) throw new WorkflowError("Choose an active warehouse.", 400);
      await tx.update(vehicles).set({ warehouse_id: data.warehouse_id, status: data.status, type: data.type, plate_number: data.plate_number.trim().toUpperCase(), version: existing.version + 1, updated_at: Math.floor(Date.now()/1000) }).where(and(eq(vehicles.id, id), eq(vehicles.is_archived, false)));
      return { message: "Vehicle updated successfully" };
    });
  }

  static async deleteVehicle(id: number, version: number) {
    throw new WorkflowError("Archive this record and schedule deletion from Archives after the 30-day retention period.", 405);
  }

  static async getVehicleForCombobox(
    page: number,
    limit: number,
    search: string,
    warehouse_id: number = -1,
  ) {
    const offset = search.length === 0 ? Math.max(page * limit, 0) : 0;
    const whereQuery = search.length
      ? ilike(vehicles.plate_number, `%${search}%`)
      : undefined;

    const [[totalResult], rows] = await Promise.all([
      db
        .select({ count: count() })
        .from(vehicles)
        .where(
          and(
            activeVehicle(),
            eq(vehicles.status, "available"),
            whereQuery,
            warehouse_id !== -1
              ? eq(vehicles.warehouse_id, warehouse_id)
              : undefined,
          ),
        ),
      db
        .select({
          id: vehicles.id,
          plate_number: vehicles.plate_number,

          type: vehicles.type,
        })
        .from(vehicles)
        .where(
          and(
            activeVehicle(),
            eq(vehicles.status, "available"),
            whereQuery,
            warehouse_id !== -1
              ? eq(vehicles.warehouse_id, warehouse_id)
              : undefined,
          ),
        )
        .orderBy(asc(vehicles.plate_number))
        .limit(limit)
        .offset(offset),
    ]);

    return { rows, total: totalResult?.count ?? 0 };
  }
}

export const vehicleService = VehicleService;
