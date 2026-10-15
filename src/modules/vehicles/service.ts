import { db } from "@/db/index";
import { vehicles } from "@/db/schema/vehicles";
import { and, asc, count, desc, eq, ilike } from "drizzle-orm";
import { VehicleType } from "./model";

type VehicleSortField = "id" | "plate_number" | "status" | "type";
type SortOrder = "asc" | "desc";

export abstract class VehicleService {
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
        .select()
        .from(vehicles)
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
    return db.query.vehicles.findFirst({ where: eq(vehicles.id, id) });
  }

  static async doesPlateNumberExist(plate_number: string, excludedId?: number) {
    const vehicle = await db.query.vehicles.findFirst({
      where: eq(vehicles.plate_number, plate_number),
    });
    return vehicle !== undefined && vehicle.id !== excludedId;
  }

  static async createVehicle(data: VehicleType) {
    const duplicate = await db.query.vehicles.findFirst({
      where: eq(vehicles.plate_number, data.plate_number),
    });
    if (duplicate)
      return { errors: { plate_number: "Plate number already exists" } };

    const now = Math.floor(Date.now() / 1000);
    const [vehicle] = await db
      .insert(vehicles)
      .values({ ...data, created_at: now, updated_at: now })
      .returning({ id: vehicles.id, plate_number: vehicles.plate_number });

    return vehicle
      ? {
          id: vehicle.id,
          message: `Vehicle ${vehicle.plate_number} created successfully`,
        }
      : { message: "Failed to create vehicle" };
  }

  static async updateVehicle(
    id: number,
    data: VehicleType & { version: number },
  ) {
    const existing = await this.getVehicleById(id);
    if (!existing) throw new Error("Vehicle not found");
    if (existing.version !== data.version)
      throw new Error("Version mismatch. Please refresh and try again.");

    if (await this.doesPlateNumberExist(data.plate_number, id)) {
      return { errors: { plate_number: "Plate number already exists" } };
    }

    const [vehicle] = await db
      .update(vehicles)
      .set({
        ...data,
        version: existing.version + 1,
        updated_at: Math.floor(Date.now() / 1000),
      })
      .where(and(eq(vehicles.id, id), eq(vehicles.version, data.version)))
      .returning();

    return vehicle
      ? { data: vehicle, message: "Vehicle updated successfully" }
      : { message: "Failed to update vehicle" };
  }

  static async deleteVehicle(id: number, version: number) {
    const existing = await this.getVehicleById(id);
    if (!existing) throw new Error("Vehicle not found");
    if (existing.version !== version)
      throw new Error("Version mismatch. Please refresh and try again.");

    await db
      .delete(vehicles)
      .where(and(eq(vehicles.id, id), eq(vehicles.version, version)));
    return { message: `Vehicle with ID ${id} deleted successfully` };
  }
}

export const vehicleService = VehicleService;
