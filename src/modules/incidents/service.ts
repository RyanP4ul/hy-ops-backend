import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db/index";
import {
  deliveries,
  deliveries_event,
  deliveries_stops,
  delivery_incidents,
  type DeliveryIncidentCategory,
  type DeliveryIncidentSeverity,
  type DeliveryIncidentStatus,
  users,
  vehicle_maintenance_logs,
  vehicles,
  warehouses,
} from "@/db/schema";
import { WorkflowError } from "../../utils/workflow-error";
import { assertDeliveryScope } from "../deliveries/scope";
import { notifyDeliveryStaff } from "../deliveries/staff-notifications";

export type CreateIncidentInput = {
  delivery_id: number;
  stop_id?: number | null;
  category: DeliveryIncidentCategory;
  severity?: DeliveryIncidentSeverity;
  description: string;
  status_notes?: string | null;
  estimated_delay_minutes?: number | null;
  latitude?: number | null;
  longitude?: number | null;
  create_maintenance_ticket?: boolean;
};

export type UpdateIncidentInput = {
  status?: DeliveryIncidentStatus;
  severity?: DeliveryIncidentSeverity;
  status_notes?: string | null;
  estimated_delay_minutes?: number | null;
};

const CATEGORY_LABELS: Record<DeliveryIncidentCategory, string> = {
  DELAY: "Transit Delay",
  TRAFFIC: "Heavy Traffic",
  BREAKDOWN: "Vehicle Breakdown",
  ACCIDENT: "Road Accident",
  WEATHER: "Severe Weather",
  OTHER: "Transit Incident",
};

export abstract class IncidentService {
  static async listIncidents(options: {
    deliveryId?: number;
    status?: DeliveryIncidentStatus;
    category?: DeliveryIncidentCategory;
    warehouseId?: number;
    limit?: number;
    offset?: number;
  }) {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const offset = Math.max(options.offset ?? 0, 0);

    const where = and(
      options.deliveryId ? eq(delivery_incidents.delivery_id, options.deliveryId) : undefined,
      options.status ? eq(delivery_incidents.status, options.status) : undefined,
      options.category ? eq(delivery_incidents.category, options.category) : undefined,
      options.warehouseId !== undefined
        ? eq(vehicles.warehouse_id, options.warehouseId)
        : undefined,
    );

    const rows = await db
      .select({
        id: delivery_incidents.id,
        delivery_id: delivery_incidents.delivery_id,
        stop_id: delivery_incidents.stop_id,
        vehicle_id: delivery_incidents.vehicle_id,
        vehicle_plate: vehicles.plate_number,
        warehouse_id: vehicles.warehouse_id,
        warehouse_name: warehouses.name,
        driver_id: deliveries.driver_id,
        delivery_status: deliveries.status,
        scheduled_date: deliveries.scheduled_date,
        departure_time: deliveries.departure_time,
        reported_by: delivery_incidents.reported_by,
        reporter_name: users.name,
        reporter_role: users.role,
        category: delivery_incidents.category,
        severity: delivery_incidents.severity,
        status: delivery_incidents.status,
        description: delivery_incidents.description,
        status_notes: delivery_incidents.status_notes,
        estimated_delay_minutes: delivery_incidents.estimated_delay_minutes,
        latitude: delivery_incidents.latitude,
        longitude: delivery_incidents.longitude,
        resolved_by: delivery_incidents.resolved_by,
        resolved_at: delivery_incidents.resolved_at,
        created_at: delivery_incidents.created_at,
        updated_at: delivery_incidents.updated_at,
      })
      .from(delivery_incidents)
      .innerJoin(deliveries, eq(deliveries.id, delivery_incidents.delivery_id))
      .innerJoin(vehicles, eq(vehicles.id, deliveries.vehicle_id))
      .leftJoin(warehouses, eq(warehouses.id, vehicles.warehouse_id))
      .innerJoin(users, eq(users.id, delivery_incidents.reported_by))
      .where(where)
      .orderBy(desc(delivery_incidents.created_at), desc(delivery_incidents.id))
      .limit(limit)
      .offset(offset);

    return rows;
  }

  static async listDriverTripIncidents(driverId: number, deliveryId: number) {
    const [delivery] = await db
      .select({ id: deliveries.id, driver_id: deliveries.driver_id })
      .from(deliveries)
      .where(eq(deliveries.id, deliveryId));
    if (!delivery || delivery.driver_id !== driverId) {
      throw new WorkflowError("Assignment not found.", 404);
    }
    return this.listIncidents({ deliveryId, limit: 50 });
  }

  static async createIncident(
    input: CreateIncidentInput,
    actor: { id: number; role: string; warehouseId?: number },
  ) {
    const description = input.description.trim();
    if (!description) {
      throw new WorkflowError("Describe what happened before logging the incident.");
    }

    return db.transaction(async (tx) => {
      const [delivery] = await tx
        .select({
          id: deliveries.id,
          driver_id: deliveries.driver_id,
          vehicle_id: deliveries.vehicle_id,
          status: deliveries.status,
        })
        .from(deliveries)
        .where(eq(deliveries.id, input.delivery_id))
        .for("share");

      if (!delivery) {
        throw new WorkflowError("Delivery not found.", 404);
      }

      if (actor.role === "driver") {
        if (delivery.driver_id !== actor.id) {
          throw new WorkflowError("Assignment not found.", 404);
        }
      } else {
        await assertDeliveryScope(tx, delivery.id, actor.warehouseId);
      }

      if (input.stop_id !== null && input.stop_id !== undefined) {
        const [stop] = await tx
          .select({ id: deliveries_stops.id })
          .from(deliveries_stops)
          .where(
            and(
              eq(deliveries_stops.id, input.stop_id),
              eq(deliveries_stops.delivery_id, delivery.id),
            ),
          );
        if (!stop) {
          throw new WorkflowError("Selected stop does not belong to this delivery.", 400);
        }
      }

      const severity: DeliveryIncidentSeverity =
        input.severity ??
        (input.category === "ACCIDENT"
          ? "critical"
          : input.category === "BREAKDOWN"
            ? "high"
            : "medium");

      const [created] = await tx
        .insert(delivery_incidents)
        .values({
          delivery_id: delivery.id,
          stop_id: input.stop_id ?? null,
          vehicle_id: delivery.vehicle_id,
          reported_by: actor.id,
          category: input.category,
          severity,
          status: "open",
          description,
          status_notes: input.status_notes?.trim() || null,
          estimated_delay_minutes:
            input.estimated_delay_minutes !== null &&
            input.estimated_delay_minutes !== undefined &&
            input.estimated_delay_minutes >= 0
              ? Math.round(input.estimated_delay_minutes)
              : null,
          latitude:
            input.latitude !== null &&
            input.latitude !== undefined &&
            Number.isFinite(input.latitude)
              ? input.latitude.toFixed(6)
              : null,
          longitude:
            input.longitude !== null &&
            input.longitude !== undefined &&
            Number.isFinite(input.longitude)
              ? input.longitude.toFixed(6)
              : null,
        })
        .returning();

      // Mirror transit delays/traffic/accidents/breakdowns into deliveries_event so
      // Analytics Delivery Issues reports automatically reflect logged incidents.
      await tx.insert(deliveries_event).values({
        delivery_id: delivery.id,
        event_type: "DELAYED",
        reason: `[${CATEGORY_LABELS[input.category]}] ${description}`.slice(0, 255),
      });

      if (input.category === "BREAKDOWN" && input.create_maintenance_ticket !== false) {
        await tx.insert(vehicle_maintenance_logs).values({
          vehicle_id: delivery.vehicle_id,
          reported_by: actor.id,
          maintenance_type: "breakdown",
          status: "open",
          title: `Transit Breakdown (Delivery #${delivery.id})`,
          description,
        });
      }

      const delaySuffix =
        created.estimated_delay_minutes && created.estimated_delay_minutes > 0
          ? ` (est. +${created.estimated_delay_minutes} min delay)`
          : "";
      await notifyDeliveryStaff(
        tx,
        { id: delivery.id, vehicle_id: delivery.vehicle_id },
        `${CATEGORY_LABELS[input.category]}: Delivery #${delivery.id}`,
        `${description}${delaySuffix}`,
        "DELIVERY_INCIDENT",
      );

      await tx.execute(
        sql`select pg_notify('hyops_resource_changed', ${JSON.stringify({
          type: "RESOURCE_CHANGED",
          payload: { resource: "deliveries", eventId: crypto.randomUUID() },
        })})`,
      );

      return created;
    });
  }

  static async updateIncident(
    incidentId: number,
    input: UpdateIncidentInput,
    actor: { id: number; warehouseId?: number },
  ) {
    return db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(delivery_incidents)
        .where(eq(delivery_incidents.id, incidentId))
        .for("update");

      if (!existing) {
        throw new WorkflowError("Incident report not found.", 404);
      }

      await assertDeliveryScope(tx, existing.delivery_id, actor.warehouseId);

      const nextStatus = input.status ?? existing.status;
      const now = new Date();
      const [updated] = await tx
        .update(delivery_incidents)
        .set({
          status: nextStatus,
          severity: input.severity ?? existing.severity,
          status_notes:
            input.status_notes !== undefined
              ? input.status_notes?.trim() || null
              : existing.status_notes,
          estimated_delay_minutes:
            input.estimated_delay_minutes !== undefined
              ? input.estimated_delay_minutes
              : existing.estimated_delay_minutes,
          resolved_by:
            nextStatus === "resolved"
              ? actor.id
              : nextStatus === "open"
                ? null
                : existing.resolved_by,
          resolved_at:
            nextStatus === "resolved"
              ? now
              : nextStatus === "open"
                ? null
                : existing.resolved_at,
          updated_at: now,
        })
        .where(eq(delivery_incidents.id, incidentId))
        .returning();

      return updated;
    });
  }
}
