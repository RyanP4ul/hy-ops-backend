import { and, eq, exists, or, sql } from "drizzle-orm";
import { db } from "../../db";
import { deliveries, notifications, staffs, users, vehicles } from "../../db/schema";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export const LOCATION_TIMEOUT_MS = 120_000;

/** Insert in the same transaction as the event and publish only after commit. */
export async function notifyDeliveryStaff(
  tx: Transaction,
  delivery: { id: number; vehicle_id: number },
  title: string,
  message: string,
  type:
    | "DELIVERY_LOCATION_STOPPED"
    | "DELIVERY_COMPLETED"
    | "DAILY_CAPACITY_FULL"
    | "DELIVERY_INCIDENT",
) {
  const [vehicle] = await tx.select({ warehouseId: vehicles.warehouse_id })
    .from(vehicles).where(eq(vehicles.id, delivery.vehicle_id));
  const recipients = await tx.select({ id: users.id }).from(users).where(and(
    eq(users.is_active, true), eq(users.is_archived, false),
    or(eq(users.role, "admin"), and(eq(users.role, "staff"), exists(
      tx.select({ id: staffs.id }).from(staffs).where(and(
        eq(staffs.user_id, users.id), eq(staffs.warehouse_id, vehicle?.warehouseId ?? -1),
      )),
    ))),
  ));
  if (!recipients.length) return;
  await tx.insert(notifications).values(recipients.map(({ id }) => ({
    user_id: id, title, message, type, created_at: Math.floor(Date.now() / 1000),
  }))).onConflictDoNothing();
  await tx.execute(sql`select pg_notify('hyops_resource_changed', ${JSON.stringify({
    type: "RESOURCE_CHANGED", payload: { resource: "notifications", eventId: crypto.randomUUID() },
  })})`);
}

/** Persist server receipt time, rather than trusting the driver's clock. */
export async function receiveDriverLocation(deliveryId: number, driverId: number) {
  await db.update(deliveries).set({ last_location_received_at: new Date(), location_alerted_at: null })
    .where(and(eq(deliveries.id, deliveryId), eq(deliveries.driver_id, driverId), eq(deliveries.status, "in_transit")));
}

export async function checkStoppedDeliveryLocations() {
  await db.transaction(async (tx) => {
    // Lock deliveries so completion, GPS receipt and concurrent workers serialize.
    const stale = await tx.select().from(deliveries).where(and(
      eq(deliveries.status, "in_transit"),
      sql`${deliveries.location_alerted_at} is null`,
      sql`coalesce(${deliveries.last_location_received_at}, ${deliveries.location_tracking_started_at}) <= now() - (${LOCATION_TIMEOUT_MS} * interval '1 millisecond')`,
    )).for("update", { skipLocked: true });
    for (const delivery of stale) {
      const count = delivery.location_alert_count + 1;
      await notifyDeliveryStaff(tx, delivery,
        `GPS lost: Delivery #${delivery.id}${count > 1 ? ` (${count})` : ""}`,
        `No location update for 2+ min. Check driver connection.`,
        "DELIVERY_LOCATION_STOPPED");
      await tx.update(deliveries).set({ location_alerted_at: new Date(), location_alert_count: count })
        .where(eq(deliveries.id, delivery.id));
    }
  });
}

export function startDeliveryLocationMonitor() {
  let running: Promise<void> | undefined;
  let stopped = false;
  function tick() {
    if (stopped || running) return;
    running = checkStoppedDeliveryLocations()
      .catch((error) => console.error("Delivery location monitor failed:", error))
      .finally(() => { running = undefined; });
  }
  const timer = setInterval(tick, 30_000);
  timer.unref();
  tick();
  return { async stop() { stopped = true; clearInterval(timer); await running; } };
}
