import { db } from "@/db/index";
import { vehicles } from "@/db/schema/vehicles";
import { and, asc, count, desc, eq, ilike, inArray } from "drizzle-orm";
import { VehicleType } from "./model";
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
    const whereQuery = search.length
      ? ilike(vehicles.plate_number, `%${search}%`)
      : undefined;

    const [totalResult, rows] = await Promise.all([
      db.select({ count: count() }).from(vehicles).where(whereQuery),
      db
        .select({
          id: vehicles.id,
          plate_number: vehicles.plate_number,
          image: vehicles.image,
          status: vehicles.status,
          type: vehicles.type,
          warehouse_id: vehicles.warehouse_id,
          warehouse_name: warehouses.name,
          version: vehicles.version,
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
          image: vehicles.image,
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
          image: vehicles.image,
        status: vehicles.status,
        type: vehicles.type,
        warehouse_id: vehicles.warehouse_id,
        warehouse_name: warehouses.name,
        version: vehicles.version,
      })
      .from(vehicles)
      .leftJoin(warehouses, eq(vehicles.warehouse_id, warehouses.id))
      .where(eq(vehicles.id, id));

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

  static async createVehicle(data: VehicleType) {
    data = { ...data, plate_number: data.plate_number.trim().toUpperCase() };
    if (data.status === "on_delivery") throw new WorkflowError("On-delivery status is managed by dispatch.", 400);
    const warehouse = await db.query.warehouses.findFirst({ where: and(eq(warehouses.id, data.warehouse_id), eq(warehouses.is_archived, false)) });
    if (!warehouse) throw new WorkflowError("Choose an active warehouse.", 400);
    const duplicate = await this.doesPlateNumberExist(data.plate_number);
    if (duplicate) return { errors: { plate_number: "Plate number already exists" } };
    const now = Math.floor(Date.now() / 1000);
    const [vehicle] = await db
      .insert(vehicles)
      .values({ ...data, created_at: now, updated_at: now })
      .returning({ id: vehicles.id, plate_number: vehicles.plate_number });

    return vehicle
      ? {
          id: vehicle.id,
          vehicle: await this.getVehicleTableRowById(vehicle.id),
          message: `Vehicle ${vehicle.plate_number} created successfully`,
        }
      : { message: "Failed to create vehicle" };
  }

  static async updateVehicle(
    id: number,
    data: VehicleType & { version: number },
  ) {
    return db.transaction(async (tx) => {
      const [existing] = await tx.select().from(vehicles).where(eq(vehicles.id, id)).for("update");
      if (!existing) throw new WorkflowError("Vehicle not found", 404);
      if (existing.version !== data.version) throw new WorkflowError("Version mismatch. Refresh and try again.");
      const [trip] = await tx.select({ id: deliveries.id }).from(deliveries).where(and(eq(deliveries.vehicle_id, id), inArray(deliveries.status, ["scheduled", "in_transit", "returning"])));
      if (trip && (data.status !== existing.status || data.warehouse_id !== existing.warehouse_id || data.type !== existing.type)) throw new WorkflowError("Reassign or complete the vehicle's scheduled/active deliveries before changing status, type or warehouse.");
      if (data.status === "on_delivery" && existing.status !== "on_delivery") throw new WorkflowError("On-delivery status is managed by dispatch.", 400);
      const warehouse = await tx.query.warehouses.findFirst({ where: and(eq(warehouses.id, data.warehouse_id), eq(warehouses.is_archived, false)) });
      if (!warehouse) throw new WorkflowError("Choose an active warehouse.", 400);
      await tx.update(vehicles).set({ ...data, plate_number: data.plate_number.trim().toUpperCase(), version: existing.version + 1, updated_at: Math.floor(Date.now()/1000) }).where(eq(vehicles.id, id));
      return { message: "Vehicle updated successfully" };
    });
  }

  static async deleteVehicle(id: number, version: number) {
    return db.transaction(async (tx) => {
      const [existing] = await tx.select().from(vehicles).where(eq(vehicles.id, id)).for("update");
      if (!existing) throw new WorkflowError("Vehicle not found", 404);
      if (existing.version !== version) throw new WorkflowError("Version mismatch. Refresh and try again.");
      const [history] = await tx.select({ id: deliveries.id }).from(deliveries).where(eq(deliveries.vehicle_id, id)).limit(1);
      if (history) throw new WorkflowError("Vehicles with delivery history cannot be deleted. Set the vehicle unavailable instead.");
      if (existing.status === "on_delivery") throw new WorkflowError("An active vehicle cannot be deleted.");
      await tx.delete(vehicles).where(eq(vehicles.id, id));
      return { id, message: "Vehicle deleted successfully" };
    });
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
          image: vehicles.image,
          type: vehicles.type,
        })
        .from(vehicles)
        .where(
          and(
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
