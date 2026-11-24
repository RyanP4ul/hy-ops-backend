import { db } from "@/db/index";
import { orders } from "@/db/schema/order";
import { deliveries, deliveries_stops } from "@/db/schema/deliveries";
import { settings } from "@/db/schema/settings";
import { drivers, users } from "@/db/schema/users";
import { vehicles } from "@/db/schema/vehicles";
import { warehouses } from "@/db/schema/warehouses";
import { and, count, eq, gte, inArray, lt, ne, or, sql } from "drizzle-orm";
import { DAY, RETURN_GRACE_MINUTES, todayInManila } from "../../utils/time";
import { activeVehicle } from "../lifecycle/availability";
import {
  parseTimeToMinutes,
  scheduleWindowMinutes,
} from "../deliveries/service";

export type AvailableDate = {
  date: string;
  available_slots: number;
  max_slots: number;
  used_slots: number;
  max_stops_per_vehicle: number;
  total_vehicles: number;
  booked_vehicles: number;
  vehicle_booked_runs: {
    delivery_id: number;
    departure_time: string;
    estimated_duration_minutes: number | null;
    status: string;
  }[];
  is_fully_booked: boolean;
};

export abstract class DeliveryScheduleService {
  private static async readScheduleSettings(): Promise<{
    globalOrderLimitPerDay: number;
    maxOrderPerVehicle: number;
  }> {
    const rows = await db
      .select({ name: settings.name, value: settings.value })
      .from(settings)
      .where(inArray(settings.name, ["order_limit_per_day", "max_order_per_vehicle"]));

    const byName = new Map(rows.map((r) => [r.name, Number(r.value)]));
    const globalOrderLimitPerDay =
      Number.isInteger(byName.get("order_limit_per_day")) &&
      (byName.get("order_limit_per_day") ?? 0) > 0
        ? (byName.get("order_limit_per_day") as number)
        : 5;
    const maxOrderPerVehicle =
      Number.isInteger(byName.get("max_order_per_vehicle")) &&
      (byName.get("max_order_per_vehicle") ?? 0) > 0
        ? (byName.get("max_order_per_vehicle") as number)
        : 5;
    return { globalOrderLimitPerDay, maxOrderPerVehicle };
  }

  static async getAvailableOrderDates({
    maxOrdersPerDay,
    daysAhead = 30,
    warehouse_id = -1,
    vehicle_id,
  }: {
    maxOrdersPerDay?: number;
    daysAhead: number;
    warehouse_id?: number;
    vehicle_id?: number;
  }): Promise<AvailableDate[]> {
    if (!Number.isInteger(daysAhead) || daysAhead < 1) {
      throw new Error("daysAhead must be a positive integer.");
    }

    const { globalOrderLimitPerDay, maxOrderPerVehicle } =
      await this.readScheduleSettings();
    let effectiveMax =
      maxOrdersPerDay && maxOrdersPerDay > 0
        ? maxOrdersPerDay
        : globalOrderLimitPerDay;
    let allowedDays = new Set<number>([1, 2, 3, 4, 5, 6]); // Mon-Sat default

    if (warehouse_id > 0) {
      const [wh] = await db
        .select({
          daily_order_limit: warehouses.daily_order_limit,
          operating_days: warehouses.operating_days,
        })
        .from(warehouses)
        .where(eq(warehouses.id, warehouse_id));
      if (wh?.daily_order_limit && wh.daily_order_limit > 0) {
        effectiveMax = wh.daily_order_limit;
      }
      if (Array.isArray(wh?.operating_days) && wh.operating_days.length > 0) {
        allowedDays = new Set(wh.operating_days);
      }
    }

    const today = todayInManila();
    const start = Date.parse(`${today}T00:00:00Z`);
    const end = new Date(start + daysAhead * DAY).toISOString().slice(0, 10);

    const [counts, [vehicleTotalRow], runsInRange] = await Promise.all([
      db
        .select({ date: deliveries.scheduled_date, orderCount: count() })
        .from(deliveries_stops)
        .innerJoin(deliveries, eq(deliveries_stops.delivery_id, deliveries.id))
        .innerJoin(orders, eq(deliveries_stops.order_id, orders.id))
        .where(
          and(
            sql`${deliveries.status} <> 'cancelled'`,
            gte(deliveries.scheduled_date, today),
            lt(deliveries.scheduled_date, end),
            warehouse_id > 0 ? eq(orders.warehouse_id, warehouse_id) : undefined,
          ),
        )
        .groupBy(deliveries.scheduled_date),
      db
        .select({ value: count() })
        .from(vehicles)
        .where(
          and(
            activeVehicle(),
            eq(vehicles.status, "available"),
            warehouse_id > 0 ? eq(vehicles.warehouse_id, warehouse_id) : undefined,
          ),
        ),
      db
        .select({
          id: deliveries.id,
          scheduled_date: deliveries.scheduled_date,
          departure_time: deliveries.departure_time,
          estimated_duration_minutes: deliveries.estimated_duration_minutes,
          vehicle_id: deliveries.vehicle_id,
          status: deliveries.status,
        })
        .from(deliveries)
        .innerJoin(vehicles, eq(vehicles.id, deliveries.vehicle_id))
        .where(
          and(
            inArray(deliveries.status, ["scheduled", "in_transit", "returning"]),
            gte(deliveries.scheduled_date, today),
            lt(deliveries.scheduled_date, end),
            warehouse_id > 0 ? eq(vehicles.warehouse_id, warehouse_id) : undefined,
          ),
        ),
    ]);

    const countByDate = new Map(
      counts.map((row) => [row.date, Number(row.orderCount)]),
    );
    const totalVehicles = Number(vehicleTotalRow?.value ?? 0);
    const bookedVehiclesByDate = new Map<string, Set<number>>();
    const vehicleRunsByDate = new Map<
      string,
      AvailableDate["vehicle_booked_runs"]
    >();

    for (const run of runsInRange) {
      const set = bookedVehiclesByDate.get(run.scheduled_date) ?? new Set<number>();
      set.add(run.vehicle_id);
      bookedVehiclesByDate.set(run.scheduled_date, set);

      if (vehicle_id && run.vehicle_id === vehicle_id) {
        const list = vehicleRunsByDate.get(run.scheduled_date) ?? [];
        list.push({
          delivery_id: run.id,
          departure_time: run.departure_time,
          estimated_duration_minutes: run.estimated_duration_minutes,
          status: run.status,
        });
        vehicleRunsByDate.set(run.scheduled_date, list);
      }
    }

    const dates: AvailableDate[] = [];
    for (let i = 0; i < daysAhead; i++) {
      const current = new Date(start + i * DAY);
      if (!allowedDays.has(current.getUTCDay())) continue;
      const date = current.toISOString().slice(0, 10);
      const usedSlots = countByDate.get(date) ?? 0;
      const availableSlots = Math.max(0, effectiveMax - usedSlots);
      const bookedVehicles = bookedVehiclesByDate.get(date)?.size ?? 0;
      dates.push({
        date,
        available_slots: availableSlots,
        max_slots: effectiveMax,
        used_slots: usedSlots,
        max_stops_per_vehicle: maxOrderPerVehicle,
        total_vehicles: totalVehicles,
        booked_vehicles: bookedVehicles,
        vehicle_booked_runs: vehicleRunsByDate.get(date) ?? [],
        is_fully_booked: availableSlots === 0,
      });
    }
    return dates;
  }

  static async checkAvailability(input: {
    warehouse_id: number;
    scheduled_date: string;
    scheduled_time: string;
    driver_id?: number;
    vehicle_id?: number;
    estimated_duration_minutes?: number | null;
    requested_stops?: number;
    exclude_delivery_id?: number;
  }) {
    const reqStart = parseTimeToMinutes(input.scheduled_time);
    const durationWithGrace = scheduleWindowMinutes(
      input.estimated_duration_minutes,
    );
    const reqEnd = reqStart + durationWithGrace;

    const { globalOrderLimitPerDay, maxOrderPerVehicle } =
      await this.readScheduleSettings();
    const [wh] = await db
      .select({ daily_order_limit: warehouses.daily_order_limit })
      .from(warehouses)
      .where(eq(warehouses.id, input.warehouse_id));
    const maxSlots =
      wh?.daily_order_limit && wh.daily_order_limit > 0
        ? wh.daily_order_limit
        : globalOrderLimitPerDay;

    const [usedRow] = await db
      .select({ stopCount: count() })
      .from(deliveries_stops)
      .innerJoin(deliveries, eq(deliveries_stops.delivery_id, deliveries.id))
      .innerJoin(orders, eq(deliveries_stops.order_id, orders.id))
      .where(
        and(
          eq(deliveries.scheduled_date, input.scheduled_date),
          sql`${deliveries.status} <> 'cancelled'`,
          eq(orders.warehouse_id, input.warehouse_id),
          input.exclude_delivery_id !== undefined
            ? ne(deliveries.id, input.exclude_delivery_id)
            : undefined,
        ),
      );
    const usedSlots = Number(usedRow?.stopCount ?? 0);
    const availableSlots = Math.max(0, maxSlots - usedSlots);
    const requestedStops = input.requested_stops ?? 1;

    const orConditions = [];
    if (input.driver_id) orConditions.push(eq(deliveries.driver_id, input.driver_id));
    if (input.vehicle_id) orConditions.push(eq(deliveries.vehicle_id, input.vehicle_id));

    const existingRuns =
      orConditions.length > 0
        ? await db
            .select({
              id: deliveries.id,
              driver_id: deliveries.driver_id,
              driver_name: users.name,
              vehicle_id: deliveries.vehicle_id,
              plate_number: vehicles.plate_number,
              departure_time: deliveries.departure_time,
              estimated_duration_minutes: deliveries.estimated_duration_minutes,
              status: deliveries.status,
            })
            .from(deliveries)
            .leftJoin(users, eq(users.id, deliveries.driver_id))
            .leftJoin(vehicles, eq(vehicles.id, deliveries.vehicle_id))
            .where(
              and(
                eq(deliveries.scheduled_date, input.scheduled_date),
                inArray(deliveries.status, ["scheduled", "in_transit", "returning"]),
                or(...orConditions),
                input.exclude_delivery_id !== undefined
                  ? ne(deliveries.id, input.exclude_delivery_id)
                  : undefined,
              ),
            )
        : [];

    const conflicts: {
      type: "driver" | "vehicle" | "capacity";
      delivery_id?: number;
      departure_time?: string;
      message: string;
    }[] = [];

    if (availableSlots < requestedStops) {
      conflicts.push({
        type: "capacity",
        message:
          availableSlots === 0
            ? `Daily delivery capacity is full (${usedSlots}/${maxSlots} stops) on ${input.scheduled_date}.`
            : `Only ${availableSlots} stop slots left on ${input.scheduled_date} (${requestedStops} requested).`,
      });
    }

    let driverAvailable = true;
    let vehicleAvailable = true;

    if (input.driver_id) {
      const [driverRow] = await db
        .select({
          status: drivers.status,
          warehouse_id: drivers.warehouse_id,
          allow_multi_warehouse: drivers.allow_multi_warehouse,
        })
        .from(drivers)
        .where(eq(drivers.user_id, input.driver_id));
      if (!driverRow || driverRow.status !== "available") {
        driverAvailable = false;
        conflicts.push({
          type: "driver",
          message: "Selected driver is currently unavailable.",
        });
      } else if (
        driverRow.warehouse_id !== input.warehouse_id &&
        !driverRow.allow_multi_warehouse
      ) {
        driverAvailable = false;
        conflicts.push({
          type: "driver",
          message:
            "Selected driver belongs to another warehouse and does not have multi-warehouse reassignment enabled.",
        });
      }
    }

    if (input.vehicle_id) {
      const [vehicleRow] = await db
        .select({ status: vehicles.status, warehouse_id: vehicles.warehouse_id })
        .from(vehicles)
        .where(and(eq(vehicles.id, input.vehicle_id), activeVehicle()));
      if (!vehicleRow || vehicleRow.status !== "available") {
        vehicleAvailable = false;
        conflicts.push({
          type: "vehicle",
          message: "Selected vehicle is currently unavailable.",
        });
      }
    }

    for (const run of existingRuns) {
      const runStart = parseTimeToMinutes(run.departure_time);
      const runEnd = runStart + scheduleWindowMinutes(run.estimated_duration_minutes);
      if (reqStart < runEnd && runStart < reqEnd) {
        if (input.driver_id && run.driver_id === input.driver_id) {
          driverAvailable = false;
          conflicts.push({
            type: "driver",
            delivery_id: run.id,
            departure_time: run.departure_time,
            message: `Driver already scheduled on Delivery #${run.id} at ${run.departure_time.slice(0, 5)} (includes ${RETURN_GRACE_MINUTES}m return grace buffer).`,
          });
        }
        if (input.vehicle_id && run.vehicle_id === input.vehicle_id) {
          vehicleAvailable = false;
          conflicts.push({
            type: "vehicle",
            delivery_id: run.id,
            departure_time: run.departure_time,
            message: `Vehicle already scheduled on Delivery #${run.id} at ${run.departure_time.slice(0, 5)} (includes ${RETURN_GRACE_MINUTES}m return grace buffer).`,
          });
        }
      }
    }

    const estimatedTripMinutes =
      input.estimated_duration_minutes && input.estimated_duration_minutes > 0
        ? Math.round(input.estimated_duration_minutes)
        : 60;
    const estimatedReturnMinutes = (reqStart + estimatedTripMinutes) % 1440;
    const estReturnTime = `${String(Math.floor(estimatedReturnMinutes / 60)).padStart(2, "0")}:${String(estimatedReturnMinutes % 60).padStart(2, "0")}`;

    return {
      available: conflicts.length === 0,
      driver_available: driverAvailable,
      vehicle_available: vehicleAvailable,
      is_fully_booked: availableSlots === 0,
      max_slots: maxSlots,
      used_slots: usedSlots,
      available_slots: availableSlots,
      max_stops_per_vehicle: maxOrderPerVehicle,
      grace_window_minutes: RETURN_GRACE_MINUTES,
      estimated_trip_minutes: estimatedTripMinutes,
      estimated_return_time: estReturnTime,
      booked_runs: existingRuns.map((run) => ({
        delivery_id: run.id,
        driver_id: run.driver_id,
        vehicle_id: run.vehicle_id,
        departure_time: run.departure_time,
        estimated_duration_minutes: run.estimated_duration_minutes,
        status: run.status,
      })),
      conflicts,
    };
  }
}
