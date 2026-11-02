import { CustomerReturnService } from "../deliveries/customer-returns";
import { DeliveryService } from "../deliveries/service";
import type { AssignmentActor } from "../deliveries/scope";
import { WorkflowError } from "../../utils/workflow-error";
import { and, eq, sql, inArray } from "drizzle-orm";
import { vehicles, warehouses, deliveries } from "../../db/schema";
import { nowEpochSeconds, todayInManila } from "../../utils/time";
import { buildFleetOverview } from "./fleet.mapper";
import {
  listOrderItems,
  listPayments,
  listRelevantDeliveries,
  listStops,
  listVehicles,
  listWarehouses,
} from "./fleet.repository";
import { db } from "@/db/index";
import { LivePositionDto, PositionIngestBody } from "./fleet.model";
import { positionSource } from "./source";

export async function getFleetOverview(actor?: AssignmentActor) {
  const [warehouseRows, vehicleRows, deliveryRows] = await Promise.all([
    listWarehouses(),
    listVehicles(),
    listRelevantDeliveries(todayInManila()),
  ]);

  const stopRows = await listStops(deliveryRows.map((row) => row.delivery.id));
  const orderIds = [...new Set(stopRows.map((row) => row.order.id))];

  const [items, payments] = await Promise.all([
    listOrderItems(orderIds),
    listPayments(orderIds),
  ]);

  const overview = buildFleetOverview({
    warehouses: warehouseRows,
    vehicles: vehicleRows,
    deliveries: deliveryRows,
    stops: stopRows,
    items,
    payments,
  });
  const returns = await CustomerReturnService.list(actor);
  return { ...overview, vehicles: overview.vehicles.map(vehicle => {
    const pickups = returns.filter(task => String(task.deliveryId) === vehicle.trip?.id);
    return { ...vehicle, status: pickups.some(task => task.status === "assigned") ? "delivering" as const : vehicle.status,
      pickups: pickups.map(task => ({ id: task.id, orderNumber: task.orderNumber, customer: task.customer, address: task.address, status: task.status, coordinates: task.coordinates, version: task.version })) };
  }) };
}

export async function assignVehicleWarehouse(
  vehicleId: number,
  warehouseId: number,
) {
  const [warehouse] = await db
    .select({ id: warehouses.id })
    .from(warehouses)
    .where(
      and(eq(warehouses.id, warehouseId), eq(warehouses.is_archived, false)),
    );
  if (!warehouse) throw new Error("Warehouse not found");

  await db.transaction(async (tx) => {
    const [vehicle] = await tx.select().from(vehicles).where(eq(vehicles.id, vehicleId)).for("update");
    if (!vehicle || vehicle.status !== "available") throw new WorkflowError("Vehicle is not available for reassignment.");
    const [trip] = await tx.select({ id: deliveries.id }).from(deliveries).where(and(eq(deliveries.vehicle_id, vehicleId), inArray(deliveries.status, ["scheduled", "in_transit", "returning"])));
    if (trip) throw new WorkflowError("Reassign or complete scheduled/active trips before changing the home warehouse.");
    await tx.update(vehicles).set({ warehouse_id: warehouseId, version: sql`${vehicles.version} + 1`, updated_at: nowEpochSeconds() }).where(eq(vehicles.id, vehicleId));
  });

  return { ok: true as const };
}

export async function getLatestPositions(): Promise<{
  positions: LivePositionDto[];
}> {
  const fixes = await positionSource.latest();
  return {
    positions: fixes.map((fix) => ({
      vehicleId: String(fix.vehicleId),
      coordinates: [fix.longitude, fix.latitude],
      speedKph: fix.speedKph,
      heading: fix.heading,
      recordedAt: fix.recordedAt.toISOString(),
      receivedAt: fix.receivedAt?.toISOString() ?? null,
      sampleIntervalSeconds: fix.sampleIntervalSeconds ?? null,
      accuracyM: fix.accuracyM ?? null,
    })),
  };
}

export async function recordPosition(
  vehicleId: number,
  body: PositionIngestBody,
) {
  if (!positionSource.record) {
    throw new Error("This position source is read-only");
  }

  const [vehicle] = await db
    .select({ id: vehicles.id })
    .from(vehicles)
    .where(eq(vehicles.id, vehicleId));
  if (!vehicle) throw new Error("Vehicle not found");

  const recordedAt = body.recordedAt ? new Date(body.recordedAt) : new Date();
  if (!Number.isFinite(recordedAt.getTime()) || !Number.isFinite(body.latitude) || !Number.isFinite(body.longitude) || Math.abs(body.latitude) > 90 || Math.abs(body.longitude) > 180) throw new WorkflowError("Invalid GPS coordinates or timestamp.", 400);
  if (recordedAt.getTime() > Date.now() + 30_000) {
    throw new WorkflowError("GPS timestamp is ahead of the server clock.", 400);
  }

  if ((body.speedKph !== undefined && (!Number.isFinite(body.speedKph) || body.speedKph < 0 || body.speedKph > 400)) || (body.heading !== undefined && (!Number.isFinite(body.heading) || body.heading < 0 || body.heading > 360)) || (body.accuracyM !== undefined && (!Number.isFinite(body.accuracyM) || body.accuracyM < 0))) throw new WorkflowError("Invalid GPS speed, heading or accuracy.", 400);
  const accepted = await positionSource.record({
    vehicleId,
    longitude: body.longitude,
    latitude: body.latitude,
    speedKph: body.speedKph ?? null,
    heading: body.heading ?? null,
    recordedAt, accuracyM: body.accuracyM ?? null,
  });

  if (accepted) {
    const returning = await db.select({ id: deliveries.id }).from(deliveries)
      .where(and(eq(deliveries.vehicle_id, vehicleId), eq(deliveries.status, "returning")));
    for (const run of returning) await DeliveryService.completeDelivery(run.id, undefined, undefined, true);
  }
  return { ok: true as const, accepted };
}
