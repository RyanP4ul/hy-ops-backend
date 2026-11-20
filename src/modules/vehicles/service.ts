import { stockTransaction } from "../inventory/transaction";
import { activeWarehouse, activeVehicle } from "../lifecycle/availability";
import { db } from "@/db/index";
import { vehicle_maintenance_logs, vehicles } from "@/db/schema/vehicles";
import { and, asc, count, desc, eq, ilike, inArray, sql } from "drizzle-orm";
import { VehicleType, VehicleCreateType } from "./model";
import { warehouses } from "@/db/schema/warehouses";
import { users } from "@/db/schema/users";

import { deliveries } from "@/db/schema/deliveries";
import { WorkflowError } from "../../utils/workflow-error";
import { createNotifications, getRecipientIdsForWarehouse } from "../../manager/automation-tasks";

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
          max_weight_kg: vehicles.max_weight_kg,
          max_volume_cbm: vehicles.max_volume_cbm,
          current_odometer_km: vehicles.current_odometer_km,
          next_service_odometer_km: vehicles.next_service_odometer_km,
          open_maintenance_count: sql<number>`(
            select count(*)::int from ${vehicle_maintenance_logs} vml
            where vml.vehicle_id = ${vehicles.id} and vml.status in ('open', 'in_progress')
          )`.mapWith(Number),
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
        max_weight_kg: vehicles.max_weight_kg,
        max_volume_cbm: vehicles.max_volume_cbm,
        current_odometer_km: vehicles.current_odometer_km,
        next_service_odometer_km: vehicles.next_service_odometer_km,
        open_maintenance_count: sql<number>`(
          select count(*)::int from ${vehicle_maintenance_logs} vml
          where vml.vehicle_id = ${vehicles.id} and vml.status in ('open', 'in_progress')
        )`.mapWith(Number),
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
      const [vehicle] = await tx.insert(vehicles).values({
        warehouse_id: data.warehouse_id,
        plate_number: data.plate_number,
        type: data.type,
        max_weight_kg: data.max_weight_kg === undefined || data.max_weight_kg === null ? null : String(data.max_weight_kg),
        max_volume_cbm: data.max_volume_cbm === undefined || data.max_volume_cbm === null ? null : String(data.max_volume_cbm),
        current_odometer_km: data.current_odometer_km === undefined ? 0 : Math.max(0, Math.round(Number(data.current_odometer_km))),
        next_service_odometer_km: data.next_service_odometer_km === undefined || data.next_service_odometer_km === null ? null : Math.max(0, Math.round(Number(data.next_service_odometer_km))),
        status: "available",
        created_at: now,
        updated_at: now,
      })
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
      await tx.update(vehicles).set({
        warehouse_id: data.warehouse_id,
        status: data.status,
        type: data.type,
        max_weight_kg: data.max_weight_kg === undefined ? existing.max_weight_kg : data.max_weight_kg === null ? null : String(data.max_weight_kg),
        max_volume_cbm: data.max_volume_cbm === undefined ? existing.max_volume_cbm : data.max_volume_cbm === null ? null : String(data.max_volume_cbm),
        current_odometer_km: data.current_odometer_km === undefined ? existing.current_odometer_km : Math.max(0, Math.round(Number(data.current_odometer_km))),
        next_service_odometer_km: data.next_service_odometer_km === undefined ? existing.next_service_odometer_km : data.next_service_odometer_km === null ? null : Math.max(0, Math.round(Number(data.next_service_odometer_km))),
        plate_number: data.plate_number.trim().toUpperCase(),
        version: existing.version + 1,
        updated_at: Math.floor(Date.now()/1000),
      }).where(and(eq(vehicles.id, id), eq(vehicles.is_archived, false)));
      return { message: "Vehicle updated successfully" };
    });
  }

  static async getMaintenanceLogs(vehicleId: number, warehouseScope?: number) {
    const [vehicle] = await db
      .select({
        id: vehicles.id,
        plate_number: vehicles.plate_number,
        status: vehicles.status,
        type: vehicles.type,
        warehouse_id: vehicles.warehouse_id,
        current_odometer_km: vehicles.current_odometer_km,
        next_service_odometer_km: vehicles.next_service_odometer_km,
        version: vehicles.version,
      })
      .from(vehicles)
      .where(and(eq(vehicles.id, vehicleId), eq(vehicles.is_archived, false)));
    if (!vehicle) throw new WorkflowError("Vehicle not found.", 404);
    if (warehouseScope !== undefined && vehicle.warehouse_id !== warehouseScope) {
      throw new WorkflowError("Vehicle is outside your assigned warehouse.", 403);
    }

    const rows = await db
      .select({
        id: vehicle_maintenance_logs.id,
        vehicle_id: vehicle_maintenance_logs.vehicle_id,
        maintenance_type: vehicle_maintenance_logs.maintenance_type,
        status: vehicle_maintenance_logs.status,
        title: vehicle_maintenance_logs.title,
        description: vehicle_maintenance_logs.description,
        workshop_name: vehicle_maintenance_logs.workshop_name,
        odometer_km: vehicle_maintenance_logs.odometer_km,
        estimated_cost: vehicle_maintenance_logs.estimated_cost,
        actual_cost: vehicle_maintenance_logs.actual_cost,
        put_in_maintenance: vehicle_maintenance_logs.put_in_maintenance,
        started_at: vehicle_maintenance_logs.started_at,
        expected_return_at: vehicle_maintenance_logs.expected_return_at,
        completed_at: vehicle_maintenance_logs.completed_at,
        version: vehicle_maintenance_logs.version,
        created_at: vehicle_maintenance_logs.created_at,
        reported_by_name: users.name,
      })
      .from(vehicle_maintenance_logs)
      .leftJoin(users, eq(users.id, vehicle_maintenance_logs.reported_by))
      .where(eq(vehicle_maintenance_logs.vehicle_id, vehicleId))
      .orderBy(desc(vehicle_maintenance_logs.created_at), desc(vehicle_maintenance_logs.id));

    const totalActualCost = rows.reduce(
      (sum, row) => sum + (row.actual_cost === null ? 0 : Number(row.actual_cost)),
      0,
    );
    const openCount = rows.filter((r) => r.status === "open" || r.status === "in_progress").length;

    return {
      vehicle,
      summary: {
        total_logs: rows.length,
        open_count: openCount,
        total_actual_cost: Math.round(totalActualCost * 100) / 100,
        service_due:
          vehicle.next_service_odometer_km !== null &&
          vehicle.current_odometer_km >= vehicle.next_service_odometer_km - 500,
      },
      rows: rows.map((row) => ({
        ...row,
        estimated_cost: row.estimated_cost === null ? null : Number(row.estimated_cost),
        actual_cost: row.actual_cost === null ? null : Number(row.actual_cost),
      })),
    };
  }

  static async createMaintenanceLog(
    vehicleId: number,
    actorId: number,
    input: {
      maintenance_type: "preventive" | "repair" | "tire_battery" | "inspection" | "breakdown";
      title: string;
      description?: string | null;
      workshop_name?: string | null;
      odometer_km?: number | null;
      estimated_cost?: number | null;
      put_in_maintenance?: boolean;
      expected_return_at?: string | null;
    },
    warehouseScope?: number,
  ) {
    return stockTransaction(async (tx) => {
      const [vehicle] = await tx
        .select()
        .from(vehicles)
        .where(and(eq(vehicles.id, vehicleId), eq(vehicles.is_archived, false)))
        .for("update");
      if (!vehicle) throw new WorkflowError("Vehicle not found.", 404);
      if (warehouseScope !== undefined && vehicle.warehouse_id !== warehouseScope) {
        throw new WorkflowError("Vehicle is outside your assigned warehouse.", 403);
      }

      const putInMaintenance = input.put_in_maintenance ?? true;
      if (putInMaintenance) {
        const [activeTrip] = await tx
          .select({ id: deliveries.id })
          .from(deliveries)
          .where(
            and(
              eq(deliveries.vehicle_id, vehicleId),
              inArray(deliveries.status, ["in_transit", "returning"]),
            ),
          )
          .limit(1);
        if (activeTrip) {
          throw new WorkflowError(
            "Vehicle currently has an active in-transit run. Log the issue without putting it into maintenance until it returns.",
            409,
          );
        }
      }

      const odometerKm =
        input.odometer_km !== undefined && input.odometer_km !== null
          ? Math.max(0, Math.round(Number(input.odometer_km)))
          : null;
      const expectedReturnAt = input.expected_return_at ? new Date(input.expected_return_at) : null;
      if (expectedReturnAt && Number.isNaN(expectedReturnAt.getTime())) {
        throw new WorkflowError("Invalid expected return date.", 400);
      }

      const [log] = await tx
        .insert(vehicle_maintenance_logs)
        .values({
          vehicle_id: vehicleId,
          reported_by: actorId,
          maintenance_type: input.maintenance_type,
          status: putInMaintenance ? "in_progress" : "open",
          title: input.title.trim(),
          description: input.description?.trim() || null,
          workshop_name: input.workshop_name?.trim() || null,
          odometer_km: odometerKm,
          estimated_cost:
            input.estimated_cost !== undefined && input.estimated_cost !== null
              ? Number(input.estimated_cost).toFixed(2)
              : null,
          put_in_maintenance: putInMaintenance,
          expected_return_at: expectedReturnAt,
        })
        .returning();

      const nextOdometer =
        odometerKm !== null && odometerKm > vehicle.current_odometer_km
          ? odometerKm
          : vehicle.current_odometer_km;
      const nextStatus = putInMaintenance ? "maintenance" : vehicle.status;

      if (nextOdometer !== vehicle.current_odometer_km || nextStatus !== vehicle.status) {
        await tx
          .update(vehicles)
          .set({
            status: nextStatus,
            current_odometer_km: nextOdometer,
            version: vehicle.version + 1,
            updated_at: Math.floor(Date.now() / 1000),
          })
          .where(eq(vehicles.id, vehicleId));
      }

      return {
        log,
        vehicle_status: nextStatus,
        current_odometer_km: nextOdometer,
        message: `Maintenance log recorded for ${vehicle.plate_number}.`,
      };
    });
  }

  static async updateMaintenanceLog(
    vehicleId: number,
    logId: number,
    actorId: number,
    input: {
      version: number;
      status: "open" | "in_progress" | "completed" | "cancelled";
      actual_cost?: number | null;
      odometer_km?: number | null;
      next_service_odometer_km?: number | null;
      workshop_name?: string | null;
      description?: string | null;
      restore_to_available?: boolean;
    },
    warehouseScope?: number,
  ) {
    return stockTransaction(async (tx) => {
      const [vehicle] = await tx
        .select()
        .from(vehicles)
        .where(and(eq(vehicles.id, vehicleId), eq(vehicles.is_archived, false)))
        .for("update");
      if (!vehicle) throw new WorkflowError("Vehicle not found.", 404);
      if (warehouseScope !== undefined && vehicle.warehouse_id !== warehouseScope) {
        throw new WorkflowError("Vehicle is outside your assigned warehouse.", 403);
      }

      const [existing] = await tx
        .select()
        .from(vehicle_maintenance_logs)
        .where(
          and(
            eq(vehicle_maintenance_logs.id, logId),
            eq(vehicle_maintenance_logs.vehicle_id, vehicleId),
          ),
        )
        .for("update");
      if (!existing) throw new WorkflowError("Maintenance log not found.", 404);
      if (existing.version !== input.version) {
        throw new WorkflowError("Maintenance log changed. Refresh and try again.", 409);
      }

      const now = new Date();
      const odometerKm =
        input.odometer_km !== undefined && input.odometer_km !== null
          ? Math.max(0, Math.round(Number(input.odometer_km)))
          : existing.odometer_km;
      const isFinishing = input.status === "completed" || input.status === "cancelled";

      const [updated] = await tx
        .update(vehicle_maintenance_logs)
        .set({
          status: input.status,
          actual_cost:
            input.actual_cost === undefined
              ? existing.actual_cost
              : input.actual_cost === null
                ? null
                : Number(input.actual_cost).toFixed(2),
          odometer_km: odometerKm,
          workshop_name:
            input.workshop_name === undefined
              ? existing.workshop_name
              : input.workshop_name?.trim() || null,
          description:
            input.description === undefined
              ? existing.description
              : input.description?.trim() || null,
          completed_by: isFinishing ? actorId : existing.completed_by,
          completed_at: isFinishing ? now : null,
          version: existing.version + 1,
          updated_at: now,
        })
        .where(eq(vehicle_maintenance_logs.id, logId))
        .returning();

      let nextStatus = vehicle.status;
      if (isFinishing && (input.restore_to_available ?? true) && vehicle.status === "maintenance") {
        const [remainingOpen] = await tx
          .select({ total: count() })
          .from(vehicle_maintenance_logs)
          .where(
            and(
              eq(vehicle_maintenance_logs.vehicle_id, vehicleId),
              inArray(vehicle_maintenance_logs.status, ["open", "in_progress"]),
            ),
          );
        if (Number(remainingOpen?.total ?? 0) === 0) {
          nextStatus = "available";
        }
      } else if (input.status === "in_progress" && existing.put_in_maintenance && vehicle.status === "available") {
        nextStatus = "maintenance";
      }

      const nextOdometer =
        odometerKm !== null && odometerKm > vehicle.current_odometer_km
          ? odometerKm
          : vehicle.current_odometer_km;
      const nextServiceOdo =
        input.next_service_odometer_km === undefined
          ? vehicle.next_service_odometer_km
          : input.next_service_odometer_km === null
            ? null
            : Math.max(0, Math.round(Number(input.next_service_odometer_km)));

      if (
        nextStatus !== vehicle.status ||
        nextOdometer !== vehicle.current_odometer_km ||
        nextServiceOdo !== vehicle.next_service_odometer_km
      ) {
        await tx
          .update(vehicles)
          .set({
            status: nextStatus,
            current_odometer_km: nextOdometer,
            next_service_odometer_km: nextServiceOdo,
            version: vehicle.version + 1,
            updated_at: Math.floor(Date.now() / 1000),
          })
          .where(eq(vehicles.id, vehicleId));
      }

      return {
        log: updated,
        vehicle_status: nextStatus,
        current_odometer_km: nextOdometer,
        message: `Maintenance log #${logId} updated to ${input.status}.`,
      };
    });
  }

  static async reportDriverVehicleIssue(
    driverId: number,
    input: {
      delivery_id?: number;
      vehicle_id?: number;
      maintenance_type?: "preventive" | "repair" | "tire_battery" | "inspection" | "breakdown";
      title: string;
      description?: string | null;
      odometer_km?: number | null;
    },
  ) {
    const result = await stockTransaction(async (tx) => {
      let targetVehicleId = input.vehicle_id;
      if (!targetVehicleId && input.delivery_id) {
        const [run] = await tx
          .select({ vehicle_id: deliveries.vehicle_id })
          .from(deliveries)
          .where(and(eq(deliveries.id, input.delivery_id), eq(deliveries.driver_id, driverId)))
          .limit(1);
        targetVehicleId = run?.vehicle_id;
      }
      if (!targetVehicleId) {
        const [latestRun] = await tx
          .select({ vehicle_id: deliveries.vehicle_id })
          .from(deliveries)
          .where(
            and(
              eq(deliveries.driver_id, driverId),
              inArray(deliveries.status, ["in_transit", "returning", "scheduled"]),
            ),
          )
          .orderBy(desc(deliveries.id))
          .limit(1);
        targetVehicleId = latestRun?.vehicle_id;
      }
      if (!targetVehicleId) {
        throw new WorkflowError("No assigned vehicle found for your active or scheduled runs.", 404);
      }

      const [assignedCheck] = await tx
        .select({ id: deliveries.id })
        .from(deliveries)
        .where(and(eq(deliveries.driver_id, driverId), eq(deliveries.vehicle_id, targetVehicleId)))
        .limit(1);
      if (!assignedCheck) {
        throw new WorkflowError("You can only report issues for vehicles assigned to your runs.", 403);
      }

      const [vehicle] = await tx
        .select()
        .from(vehicles)
        .where(and(eq(vehicles.id, targetVehicleId), eq(vehicles.is_archived, false)))
        .for("update");
      if (!vehicle) throw new WorkflowError("Vehicle not found.", 404);

      const odometerKm =
        input.odometer_km !== undefined && input.odometer_km !== null
          ? Math.max(0, Math.round(Number(input.odometer_km)))
          : null;

      const [log] = await tx
        .insert(vehicle_maintenance_logs)
        .values({
          vehicle_id: vehicle.id,
          reported_by: driverId,
          maintenance_type: input.maintenance_type ?? "repair",
          status: "open",
          title: input.title.trim(),
          description: input.description?.trim() || null,
          odometer_km: odometerKm,
          put_in_maintenance: false,
        })
        .returning();

      if (odometerKm !== null && odometerKm > vehicle.current_odometer_km) {
        await tx
          .update(vehicles)
          .set({
            current_odometer_km: odometerKm,
            version: vehicle.version + 1,
            updated_at: Math.floor(Date.now() / 1000),
          })
          .where(eq(vehicles.id, vehicle.id));
      }

      return { log, vehicle };
    });

    const recipients = await getRecipientIdsForWarehouse(result.vehicle.warehouse_id);
    await createNotifications(
      recipients,
      `Vehicle issue reported: ${result.vehicle.plate_number}`,
      `${input.title.trim()}${input.odometer_km ? ` (Odometer: ${input.odometer_km} km)` : ""}`,
      "VEHICLE_MAINTENANCE",
    );

    return {
      log: result.log,
      vehicle_id: result.vehicle.id,
      plate_number: result.vehicle.plate_number,
      message: `Issue reported for vehicle ${result.vehicle.plate_number}. Warehouse staff have been notified.`,
    };
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
          max_weight_kg: vehicles.max_weight_kg,
          max_volume_cbm: vehicles.max_volume_cbm,
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
