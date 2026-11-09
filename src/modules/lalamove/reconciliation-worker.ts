import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import { db } from "../../db";
import { delivery_orders, lalamove_events, lalamove_provider_ids } from "../../db/schema/lalamove";
import { orders } from "../../db/schema/order";
import { lalamoveConfig } from "../../plugins/lalamove";
import { LalamoveService } from "./service";

export async function processLalamoveEvents() {
  const config = lalamoveConfig();
  const scope = `${config.environment}:${config.market}:`;
  const events = await db.select().from(lalamove_events).where(and(eq(lalamove_events.environment, config.environment),
    inArray(lalamove_events.state, ["PENDING", "RETRY"]), lt(lalamove_events.attempts, 20), lt(lalamove_events.next_attempt_at, new Date()))).orderBy(asc(lalamove_events.created_at)).limit(10);
  for (const event of events) {
    if (!event.dedupe_key.startsWith(scope)) continue;
    try {
      const data = event.payload as { order?: { orderId?: string; metadata?: { bookingId?: string; orderId?: string } }; prevOrderId?: string };
      const providerId = data.order?.orderId;
      if (!providerId) {
        await db.update(lalamove_events).set({ state: "ACCOUNT_EVENT", processed_at: new Date() }).where(eq(lalamove_events.id, event.id));
        continue;
      }
      let [alias] = await db.select().from(lalamove_provider_ids).where(eq(lalamove_provider_ids.identity, `${scope}${data.prevOrderId ?? providerId}`));
      // Unmatched early events remain durable until booking persistence or operator reconciliation.
      if (!alias) {
        const [booking] = await db.select().from(delivery_orders).where(and(eq(delivery_orders.lalamove_order_id, providerId), eq(delivery_orders.environment, config.environment), eq(delivery_orders.market, config.market)));
        if (booking) alias = { identity: `${scope}${providerId}`, booking_id: booking.id };
      }
      if (!alias) throw new Error("Unmatched provider event; operator reconciliation may be required.");
      if (data.prevOrderId && data.prevOrderId !== providerId) {
        await db.transaction(async tx => {
          const [initial] = await tx.select().from(delivery_orders).where(eq(delivery_orders.id, alias.booking_id));
          if (!initial.order_id) throw new Error("Legacy unlinked booking.");
          await tx.select().from(orders).where(eq(orders.id, initial.order_id)).for("update");
          const [booking] = await tx.select().from(delivery_orders).where(eq(delivery_orders.id, initial.id)).for("update");
          if (booking.lalamove_order_id === data.prevOrderId) {
            await tx.insert(lalamove_provider_ids).values({ identity: `${scope}${providerId}`, booking_id: booking.id }).onConflictDoNothing();
            await tx.update(delivery_orders).set({ lalamove_order_id: providerId, active: true, booking_state: "CONFIRMED", last_synced_at: null }).where(eq(delivery_orders.id, booking.id));
          }
        });
      }
      // Read authoritative state; never apply stale event statuses or trust metadata alone.
      await LalamoveService.refresh(alias.booking_id);
      await db.update(lalamove_events).set({ state: "PROCESSED", processed_at: new Date(), last_error: null }).where(eq(lalamove_events.id, event.id));
    } catch {
      await db.update(lalamove_events).set({ state: event.attempts >= 19 ? "REVIEW" : "RETRY", attempts: sql`${lalamove_events.attempts} + 1`, next_attempt_at: new Date(Date.now() + Math.min(3600000, 60000 * 2 ** Math.min(event.attempts, 6)) + Math.random() * 10000), last_error: "Unable to reconcile provider event. Check booking and provider connection." }).where(eq(lalamove_events.id, event.id));
    }
  }
}

export async function reconcileLalamoveBookings() {
  const config = lalamoveConfig();
  await db.update(delivery_orders).set({ booking_state: "UNKNOWN", failure_message: "Submission was interrupted. Reconcile before booking again." })
    .where(and(eq(delivery_orders.booking_state, "CREATING"), lt(delivery_orders.created_at, Math.floor(Date.now() / 1000) - 120)));
  const stale = await db.select().from(delivery_orders).where(and(eq(delivery_orders.active, true), eq(delivery_orders.environment, config.environment), eq(delivery_orders.market, config.market),
    sql`${delivery_orders.lalamove_order_id} is not null`, sql`(${delivery_orders.last_synced_at} is null or ${delivery_orders.last_synced_at} < now() - interval '2 minutes')`)).orderBy(asc(delivery_orders.updated_at)).limit(5);
  for (const booking of stale) {
    try { await LalamoveService.refresh(booking.id); }
    catch { /* Keep claim and stale timestamp; next sweep retries without creating a booking. */ }
  }
}
export function startLalamoveWorker() {
  let running: Promise<void> | undefined;
  const tick = () => {
    if (running || !process.env.LALAMOVE_API_KEY || !process.env.LALAMOVE_API_SECRET) return;
    running = (async () => {
      // One worker per database across replicas, without holding order locks during network calls.
      await db.transaction(async tx => {
        const result = await tx.execute(sql`select pg_try_advisory_xact_lock(721009) as acquired`);
        if (!result[0]?.acquired) return;
        await processLalamoveEvents(); await reconcileLalamoveBookings();
      });
    })().catch(() => console.error("Lalamove reconciliation sweep failed; pending work retained.")).finally(() => { running = undefined; });
  };
  const timer = setInterval(tick, 60000); timer.unref();
  return { stop: async () => { clearInterval(timer); await running; } };
}
