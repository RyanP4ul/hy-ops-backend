import { activeWarehouse } from "../lifecycle/availability";
import { and, asc, count, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { db } from "../../db";
import { order_groups, orders } from "../../db/schema/order";
import { customers, users } from "../../db/schema/users";
import { warehouses } from "../../db/schema/warehouses";
import { delivery_order_stops, delivery_orders, lalamove_events, lalamove_provider_ids, lalamove_quotations } from "../../db/schema/lalamove";
import { LalamoveError, lalamoveConfig, lalamoveRequest, requireLalamoveBooking } from "../../plugins/lalamove";
import { staffWarehouse, type AssignmentActor } from "../deliveries/scope";
import { stockTransaction, type StockTransaction } from "../inventory/transaction";
import { changeOrderStock } from "../order/stock";
import { queueExternalDeliveryNotification } from "../deliveries/notification-queue";
import { WorkflowError } from "../../utils/workflow-error";
import { coordinates } from "../../utils/coordinates";
import { assertNoExternalClaim, assertNoInternalClaim } from "./fulfillment";
import { assertReady, fingerprint, internationalPhone, MAX_LALAMOVE_DROPOFF_STOPS, safeTrackingLink, terminalStatuses } from "./rules";
import type { LalamoveQuotationResponse, LalamoveStop, PlaceOrderResponse } from "./model";
import { lalamoveCallback } from "./webhook-config";

type Actor = AssignmentActor;
type StopPoint = { address: string; lat: string; lng: string; name: string; phone: string };
type Route = { pickup: StopPoint; dropoff: StopPoint };
type MultiStopDropoff = StopPoint & { order_id: number; order_number: string; stop_id?: string };
type MultiStopRoute = { pickup: StopPoint; dropoffs: MultiStopDropoff[] };

export type DriverCoordinates = {
  lat: number;
  lng: number;
  updated_at: string | null;
};

export type BookingStopSummary = {
  id: number;
  booking_id: number;
  order_id: number;
  order_number: string;
  order_status: string;
  stop_index: number;
  lalamove_stop_id: string | null;
  recipient_name: string;
  recipient_phone: string;
  dropoff_address: string;
  dropoff_lat: string | null;
  dropoff_lng: string | null;
  pod_status: string | null;
  delivered_at: Date | null;
};

export function extractDriverCoordinates(driverDetails: unknown): DriverCoordinates | null {
  if (!driverDetails || typeof driverDetails !== "object") return null;
  const coords = (driverDetails as { coordinates?: { lat?: unknown; lng?: unknown; updatedAt?: unknown } }).coordinates;
  if (!coords || typeof coords !== "object") return null;
  const parsed = coordinates(
    coords.lat as string | number | null | undefined,
    coords.lng as string | number | null | undefined,
  );
  if (!parsed) return null;
  const rawUpdated = typeof coords.updatedAt === "string" && coords.updatedAt.trim() ? coords.updatedAt.trim() : null;
  return {
    lat: Number(parsed.latitude),
    lng: Number(parsed.longitude),
    updated_at: rawUpdated,
  };
}

const now = () => Math.floor(Date.now() / 1000);
const identity = (id: string) => `${lalamoveConfig().environment}:${lalamoveConfig().market}:${id}`;

export async function notifyLalamove(tx: StockTransaction) {
  for (const resource of ["orders", "deliveries", "inventory", "lalamove", "reports"]) {
    await tx.execute(sql`select pg_notify('hyops_resource_changed', ${JSON.stringify({ type: "RESOURCE_CHANGED", payload: { resource, eventId: crypto.randomUUID() } })})`);
  }
}

function buildPickupPoint(warehouse: typeof warehouses.$inferSelect | undefined): StopPoint {
  const pickup = warehouse && !warehouse.is_archived && warehouse.is_active && coordinates(warehouse.latitude, warehouse.longitude);
  if (!warehouse || !pickup) throw new WorkflowError("Verify warehouse and order destination coordinates first.");
  if (!warehouse.name?.trim()) throw new WorkflowError("Saved warehouse name and order recipient/address are required.");
  if (![warehouse.street_address, warehouse.city, warehouse.state, warehouse.zip_code].every(value => value?.trim())) {
    throw new WorkflowError("Save a complete warehouse pickup address first.");
  }
  return {
    address: [warehouse.street_address, warehouse.city, warehouse.state, warehouse.zip_code].join(", "),
    lat: String(pickup.latitude),
    lng: String(pickup.longitude),
    name: warehouse.name,
    phone: internationalPhone(warehouse.phone_number),
  };
}

function buildDropoffPoint(order: typeof orders.$inferSelect): MultiStopDropoff {
  const dropoff = coordinates(order.shipping_latitude, order.shipping_longitude);
  if (!dropoff) throw new WorkflowError(`Verify destination coordinates for ${order.order_number} first.`);
  if (!order.shipping_recipient?.trim() || !order.shipping_address?.trim()) {
    throw new WorkflowError(`Saved recipient name and shipping address are required for ${order.order_number}.`);
  }
  return {
    order_id: order.id,
    order_number: order.order_number,
    address: order.shipping_address,
    lat: String(dropoff.latitude),
    lng: String(dropoff.longitude),
    name: order.shipping_recipient,
    phone: internationalPhone(order.shipping_phone),
  };
}

function stripStopIds(route: MultiStopRoute) {
  return {
    pickup: route.pickup,
    dropoffs: route.dropoffs.map(({ stop_id: _sid, ...rest }) => rest),
  };
}

function matchProviderDropoffs(
  requested: MultiStopDropoff[],
  providerDropoffs: LalamoveStop[],
  isRouteOptimized: boolean,
): { dropoffs: MultiStopDropoff[]; reordered: boolean } {
  if (!isRouteOptimized) {
    return {
      dropoffs: requested.map((item, idx) => ({ ...item, stop_id: providerDropoffs[idx]?.stopId })),
      reordered: false,
    };
  }
  const remaining = [...requested];
  const matched: MultiStopDropoff[] = [];
  for (const pStop of providerDropoffs) {
    let pickIdx = -1;
    const pLat = pStop.coordinates?.lat !== undefined ? Number(pStop.coordinates.lat) : NaN;
    const pLng = pStop.coordinates?.lng !== undefined ? Number(pStop.coordinates.lng) : NaN;
    if (Number.isFinite(pLat) && Number.isFinite(pLng)) {
      let bestDist = Infinity;
      remaining.forEach((candidate, idx) => {
        const dist = Math.hypot(Number(candidate.lat) - pLat, Number(candidate.lng) - pLng);
        if (dist < bestDist) {
          bestDist = dist;
          pickIdx = idx;
        }
      });
      if (bestDist > 0.002) pickIdx = -1;
    }
    if (pickIdx === -1 && pStop.address?.trim()) {
      const targetAddr = pStop.address.trim().toLowerCase();
      pickIdx = remaining.findIndex(candidate => candidate.address.trim().toLowerCase() === targetAddr);
    }
    if (pickIdx === -1) pickIdx = 0;
    const [chosen] = remaining.splice(pickIdx, 1);
    matched.push({ ...chosen, stop_id: pStop.stopId });
  }
  const reordered = matched.some((item, idx) => item.order_id !== requested[idx]?.order_id);
  return { dropoffs: matched, reordered };
}

export abstract class LalamoveService {
  static async setup(actor: Actor) {
    await staffWarehouse(actor);
    const config = lalamoveConfig();
    const canManage = actor.role === "admin";
    if (!canManage) return { enabled: process.env.LALAMOVE_ENABLED === "true", environment: config.environment, can_manage: false, callback_url: null, callback_path: null, last_callback_at: null };
    const callback = lalamoveCallback();
    const [event] = await db.select({ received_at: lalamove_events.created_at }).from(lalamove_events)
      .where(and(eq(lalamove_events.environment, config.environment), sql`${lalamove_events.dedupe_key} like ${`${config.environment}:${config.market}:%`}`))
      .orderBy(desc(lalamove_events.created_at)).limit(1);
    return {
      enabled: process.env.LALAMOVE_ENABLED === "true",
      environment: config.environment,
      can_manage: true,
      callback_url: callback.url,
      callback_path: callback.path,
      last_callback_at: event?.received_at ?? null,
    };
  }

  static async registerWebhook(actor: Actor) {
    if (actor.role !== "admin") throw new WorkflowError("Administrator access required.", 403);
    const callback = lalamoveCallback();
    if (!callback.url) throw new WorkflowError("Set LALAMOVE_WEBHOOK_URL to your public HTTPS backend callback first.");
    await lalamoveRequest("PATCH", "/webhook", { data: { url: callback.url } });
    return { message: "Webhook URL registered. Select webhook event version v3 in Lalamove Partner Portal.", url: callback.url };
  }

  static async reconciliation(actor: Actor) {
    await staffWarehouse(actor);
    if (actor.role !== "admin") return { can_reconcile: false, events: [] };
    const config = lalamoveConfig();
    const events = await db.select({ id: lalamove_events.id, event_type: lalamove_events.event_type, provider_order_id: lalamove_events.provider_order_id, state: lalamove_events.state, attempts: lalamove_events.attempts, last_error: lalamove_events.last_error }).from(lalamove_events)
      .where(and(eq(lalamove_events.environment, config.environment), inArray(lalamove_events.state, ["RETRY", "REVIEW"]))).orderBy(desc(lalamove_events.created_at)).limit(100);
    return { can_reconcile: true, events };
  }

  static async retryEvent(id: string, actor: Actor) {
    if (actor.role !== "admin") throw new WorkflowError("Administrator access required.", 403);
    const config = lalamoveConfig();
    await db.update(lalamove_events).set({ state: "PENDING", attempts: 0, next_attempt_at: new Date(), last_error: null })
      .where(and(eq(lalamove_events.id, id), eq(lalamove_events.environment, config.environment), inArray(lalamove_events.state, ["RETRY", "REVIEW"])));
    return { message: "Event queued for reconciliation." };
  }

  static async eligible(actor: Actor) {
    const scope = await staffWarehouse(actor);
    const rows = await db
      .select({
        id: orders.id,
        order_number: orders.order_number,
        version: orders.version,
        warehouse_id: orders.warehouse_id,
        lalamove_pickup_warehouse_id: orders.lalamove_pickup_warehouse_id,
        delivery_method: orders.delivery_method,
        payment_arrangement: orders.payment_arrangement,
        stock_reserved: orders.stock_reserved,
        shipping_recipient: orders.shipping_recipient,
        shipping_phone: orders.shipping_phone,
        shipping_address: orders.shipping_address,
        shipping_latitude: orders.shipping_latitude,
        shipping_longitude: orders.shipping_longitude,
        order_group_id: orders.order_group_id,
        order_group_position: orders.order_group_position,
        order_group_number: order_groups.group_number,
        customer_company: customers.company_name,
        customer_name: users.name,
      })
      .from(orders)
      .leftJoin(order_groups, eq(order_groups.id, orders.order_group_id))
      .leftJoin(customers, eq(customers.id, orders.customer_id))
      .leftJoin(users, eq(users.id, customers.user_id))
      .where(
        and(
          eq(orders.status, "SCHEDULING"),
          scope === undefined ? undefined : eq(orders.warehouse_id, scope),
          sql`coalesce(${orders.delivery_method}, '') <> 'WALK_IN'`,
          sql`not exists (select 1 from delivery_orders b where b.order_id = ${orders.id} and b.active)`,
          sql`not exists (select 1 from delivery_order_stops s where s.order_id = ${orders.id} and s.active)`,
          sql`not exists (select 1 from deliveries_stops ds inner join deliveries d on d.id = ds.delivery_id where ds.order_id = ${orders.id} and d.status in ('scheduled', 'in_transit', 'returning'))`,
        ),
      )
      .orderBy(desc(orders.id))
      .limit(100);

    const groupCounts = new Map<string, number>();
    for (const row of rows) {
      if (row.order_group_id) groupCounts.set(row.order_group_id, (groupCounts.get(row.order_group_id) ?? 0) + 1);
    }

    return rows.map((row) => {
      let ready_for_lalamove = true;
      let blocked_reason: string | null = null;
      try {
        assertReady({
          status: "SCHEDULING",
          delivery_method: row.delivery_method,
          stock_reserved: row.stock_reserved,
          payment_arrangement: row.payment_arrangement,
        });
        if (!coordinates(row.shipping_latitude, row.shipping_longitude)) {
          throw new WorkflowError("Verify order destination coordinates first.");
        }
        if (!row.shipping_recipient?.trim() || !row.shipping_address?.trim()) {
          throw new WorkflowError("Recipient name and shipping address are required.");
        }
        internationalPhone(row.shipping_phone);
      } catch (cause) {
        ready_for_lalamove = false;
        blocked_reason = cause instanceof Error ? cause.message : "Order is not ready for Lalamove.";
      }
      return {
        ...row,
        order_group_size: row.order_group_id ? (groupCounts.get(row.order_group_id) ?? 1) : null,
        ready_for_lalamove,
        blocked_reason,
      };
    });
  }

  static async order(id: number, actor: Actor) {
    const scope = await staffWarehouse(actor);
    const [order] = await db.select().from(orders).where(and(eq(orders.id, id), scope === undefined ? undefined : eq(orders.warehouse_id, scope)));
    if (!order) throw new WorkflowError("Order not found in your warehouse.", 404);
    return order;
  }

  static async loadBookingStops(bookingIds: number[]): Promise<Map<number, BookingStopSummary[]>> {
    const map = new Map<number, BookingStopSummary[]>();
    if (!bookingIds.length) return map;
    const rows = await db
      .select({
        id: delivery_order_stops.id,
        booking_id: delivery_order_stops.booking_id,
        order_id: delivery_order_stops.order_id,
        order_number: orders.order_number,
        order_status: orders.status,
        stop_index: delivery_order_stops.stop_index,
        lalamove_stop_id: delivery_order_stops.lalamove_stop_id,
        recipient_name: delivery_order_stops.recipient_name,
        recipient_phone: delivery_order_stops.recipient_phone,
        dropoff_address: delivery_order_stops.dropoff_address,
        dropoff_lat: delivery_order_stops.dropoff_lat,
        dropoff_lng: delivery_order_stops.dropoff_lng,
        pod_status: delivery_order_stops.pod_status,
        delivered_at: delivery_order_stops.delivered_at,
      })
      .from(delivery_order_stops)
      .innerJoin(orders, eq(orders.id, delivery_order_stops.order_id))
      .where(inArray(delivery_order_stops.booking_id, bookingIds))
      .orderBy(asc(delivery_order_stops.stop_index), asc(delivery_order_stops.id));

    for (const row of rows) {
      const list = map.get(row.booking_id) ?? [];
      list.push(row);
      map.set(row.booking_id, list);
    }
    return map;
  }

  static async booking(id: number, actor: Actor) {
    const scope = await staffWarehouse(actor);
    const [booking] = await db.select().from(delivery_orders).where(eq(delivery_orders.id, id));
    if (!booking) throw new WorkflowError("Order-linked booking not found.", 404);
    const stopRows = await db
      .select({ order_id: delivery_order_stops.order_id, warehouse_id: orders.warehouse_id })
      .from(delivery_order_stops)
      .innerJoin(orders, eq(orders.id, delivery_order_stops.order_id))
      .where(eq(delivery_order_stops.booking_id, booking.id));

    if (stopRows.length > 0) {
      if (scope !== undefined && stopRows.some((row) => row.warehouse_id !== scope)) {
        throw new WorkflowError("Order not found in your warehouse.", 404);
      }
      return booking;
    }
    if (!booking.order_id) throw new WorkflowError("Order-linked booking not found.", 404);
    await this.order(booking.order_id, actor);
    return booking;
  }

  static assertEnvironment(booking: typeof delivery_orders.$inferSelect) {
    const config = lalamoveConfig();
    if (booking.environment !== config.environment || booking.market !== config.market) throw new WorkflowError("Switch to this booking's provider environment before synchronizing it.");
  }

  static async bookingContext(id: number, actor: Actor) {
    const booking = await this.booking(id, actor);
    const stopsMap = await this.loadBookingStops([booking.id]);
    const stops = stopsMap.get(booking.id) ?? [];
    const primaryOrderId = stops[0]?.order_id ?? booking.order_id;
    let pickupWarehouseId = booking.pickup_warehouse_id;
    if (!pickupWarehouseId && primaryOrderId) {
      const [primaryOrder] = await db.select({ warehouse_id: orders.warehouse_id, pickup_id: orders.lalamove_pickup_warehouse_id }).from(orders).where(eq(orders.id, primaryOrderId));
      pickupWarehouseId = primaryOrder?.pickup_id ?? primaryOrder?.warehouse_id ?? null;
    }
    const [warehouse] = pickupWarehouseId
      ? await db.select().from(warehouses).where(eq(warehouses.id, pickupWarehouseId))
      : [undefined];
    const aliases = await db.select().from(lalamove_provider_ids).where(eq(lalamove_provider_ids.booking_id, booking.id));
    const config = lalamoveConfig();
    const providerIds = aliases
      .filter(alias => alias.identity.startsWith(`${config.environment}:${config.market}:`))
      .map(alias => alias.identity.split(":").slice(2).join(":"));
    const history = providerIds.length
      ? await db
          .select({ id: lalamove_events.id, event_type: lalamove_events.event_type, state: lalamove_events.state, created_at: lalamove_events.created_at, last_error: lalamove_events.last_error })
          .from(lalamove_events)
          .where(and(eq(lalamove_events.environment, config.environment), inArray(lalamove_events.provider_order_id, providerIds)))
          .orderBy(desc(lalamove_events.created_at))
          .limit(100)
      : [];
    return {
      booking: this.summary(booking, stops),
      warehouse: warehouse ?? null,
      history,
      can_reconcile: actor.role === "admin",
      ...config,
      base: undefined,
      enabled: process.env.LALAMOVE_ENABLED === "true",
    };
  }

  static async context(id: number, actor: Actor) {
    const order = await this.order(id, actor);
    const [warehouse] = await db.select().from(warehouses).where(eq(warehouses.id, order.lalamove_pickup_warehouse_id ?? order.warehouse_id));
    const stopBookingRows = await db
      .select({ booking_id: delivery_order_stops.booking_id })
      .from(delivery_order_stops)
      .where(eq(delivery_order_stops.order_id, id));
    const linkedBookingIds = Array.from(new Set(stopBookingRows.map(row => row.booking_id)));
    const bookings = await db
      .select()
      .from(delivery_orders)
      .where(linkedBookingIds.length ? or(eq(delivery_orders.order_id, id), inArray(delivery_orders.id, linkedBookingIds)) : eq(delivery_orders.order_id, id))
      .orderBy(desc(delivery_orders.id));
    const stopsMap = await this.loadBookingStops(bookings.map(row => row.id));
    const aliases = bookings.length ? await db.select().from(lalamove_provider_ids).where(inArray(lalamove_provider_ids.booking_id, bookings.map(row => row.id))) : [];
    const config = lalamoveConfig();
    const providerIds = aliases.filter(alias => alias.identity.startsWith(`${config.environment}:${config.market}:`)).map(alias => alias.identity.split(":").slice(2).join(":"));
    const history = providerIds.length ? await db.select({ id: lalamove_events.id, event_type: lalamove_events.event_type, state: lalamove_events.state, created_at: lalamove_events.created_at, last_error: lalamove_events.last_error })
      .from(lalamove_events).where(and(eq(lalamove_events.environment, lalamoveConfig().environment), inArray(lalamove_events.provider_order_id, providerIds))).orderBy(desc(lalamove_events.created_at)).limit(100) : [];
    let eligible = true;
    let reason: string | null = null;
    try { assertReady(order); await this.route(order); } catch (e) { eligible = false; reason = e instanceof Error ? e.message : "Order is not ready."; }
    return {
      order,
      warehouse,
      bookings: bookings.map(row => this.summary(row, stopsMap.get(row.id))),
      history,
      eligible,
      reason,
      can_reconcile: actor.role === "admin",
      ...lalamoveConfig(),
      base: undefined,
      enabled: process.env.LALAMOVE_ENABLED === "true",
    };
  }

  static summary(row: typeof delivery_orders.$inferSelect, stops?: BookingStopSummary[]) {
    // Keep raw provider responses, route PII, and delivery codes off list/history contracts.
    const { lalamove_response: _raw, route_snapshot: _route, request_fingerprint: _fingerprint, ...summary } = row;
    const response = row.lalamove_response as PlaceOrderResponse | null;
    const stopByProviderId = new Map<string, BookingStopSummary>();
    for (const stop of stops ?? []) {
      if (stop.lalamove_stop_id) stopByProviderId.set(stop.lalamove_stop_id, stop);
    }
    const evidence = response?.stops?.flatMap(stop => {
      if (!stop.POD) return [];
      const linked = stopByProviderId.get(stop.stopId);
      return [{
        stop_id: stop.stopId,
        status: stop.POD.status ?? "PENDING",
        delivered_at: stop.POD.deliveredAt ?? null,
        ...(linked ? { order_id: linked.order_id, order_number: linked.order_number, stop_index: linked.stop_index } : {}),
      }];
    }) ?? [];
    return {
      ...summary,
      stop_count: stops?.length ? stops.length : row.stop_count,
      stops: stops ?? [],
      driver_coordinates: extractDriverCoordinates(row.driver_details),
      evidence,
      share_link: safeTrackingLink(row.share_link),
    };
  }

  static async list(actor: Actor, page = 0) {
    const scope = await staffWarehouse(actor);
    const rows = await db
      .select({ booking: delivery_orders, order_number: orders.order_number })
      .from(delivery_orders)
      .innerJoin(orders, eq(orders.id, delivery_orders.order_id))
      .where(
        scope === undefined
          ? undefined
          : or(
              eq(orders.warehouse_id, scope),
              sql`exists (select 1 from delivery_order_stops s inner join orders o on o.id = s.order_id where s.booking_id = ${delivery_orders.id} and o.warehouse_id = ${scope})`,
            ),
      )
      .orderBy(desc(delivery_orders.id))
      .limit(50)
      .offset(page * 50);
    const stopsMap = await this.loadBookingStops(rows.map(row => row.booking.id));
    return rows.map(row => ({
      ...this.summary(row.booking, stopsMap.get(row.booking.id)),
      order_number: row.order_number,
    }));
  }

  static async setMethod(id: number, version: number, method: string, actor: Actor) {
    await this.order(id, actor);
    return db.transaction(async tx => {
      const [order] = await tx.select().from(orders).where(eq(orders.id, id)).for("update");
      if (!order || order.version !== version || !["PENDING", "PROCESSING", "SCHEDULING"].includes(order.status)) throw new WorkflowError("Order changed or is already scheduled. Refresh first.");
      await assertNoExternalClaim(tx, id);
      await assertNoInternalClaim(tx, id);
      await tx.update(orders).set({ delivery_method: method, version: order.version + 1, updated_at: new Date() }).where(eq(orders.id, id));
      await notifyLalamove(tx);
      return { message: "Delivery method saved." };
    });
  }

  static async setMethodsBatch(items: { order_id: number; version: number }[], method: string, actor: Actor) {
    if (!items.length || items.length > MAX_LALAMOVE_DROPOFF_STOPS) {
      throw new WorkflowError(`Select between 1 and ${MAX_LALAMOVE_DROPOFF_STOPS} orders.`, 400);
    }
    const scope = await staffWarehouse(actor);
    const uniqueIds = Array.from(new Set(items.map(item => item.order_id)));
    if (uniqueIds.length !== items.length) throw new WorkflowError("Duplicate orders in selection.", 400);
    const versionById = new Map(items.map(item => [item.order_id, item.version]));
    const sortedIds = [...uniqueIds].sort((a, b) => a - b);

    return db.transaction(async tx => {
      const locked = await tx.select().from(orders).where(inArray(orders.id, sortedIds)).orderBy(asc(orders.id)).for("update");
      if (locked.length !== sortedIds.length) throw new WorkflowError("One or more orders were not found.", 404);
      const updated: { id: number; version: number; delivery_method: string }[] = [];
      for (const order of locked) {
        if (scope !== undefined && order.warehouse_id !== scope) throw new WorkflowError("Order not found in your warehouse.", 404);
        if (order.version !== versionById.get(order.id) || !["PENDING", "PROCESSING", "SCHEDULING"].includes(order.status)) {
          throw new WorkflowError(`Order ${order.order_number} changed or is already scheduled. Refresh first.`);
        }
        await assertNoExternalClaim(tx, order.id);
        await assertNoInternalClaim(tx, order.id);
        const nextVersion = order.version + 1;
        await tx.update(orders).set({ delivery_method: method, version: nextVersion, updated_at: new Date() }).where(eq(orders.id, order.id));
        updated.push({ id: order.id, version: nextVersion, delivery_method: method });
      }
      await notifyLalamove(tx);
      return { message: `Updated delivery method for ${updated.length} ${updated.length === 1 ? "order" : "orders"}.`, orders: updated };
    });
  }

  static async pickup(id: number, name: string, phone: string, actor: Actor) {
    const order = await this.order(id, actor);
    const scope = await staffWarehouse(actor);
    const pickupId = order.lalamove_pickup_warehouse_id ?? order.warehouse_id;
    if (scope !== undefined && pickupId !== scope) throw new WorkflowError("Pickup warehouse is outside your assigned warehouse.", 403);
    await db.update(warehouses).set({ pickup_contact_name: name.trim(), pickup_contact_phone: internationalPhone(phone), phone_number: internationalPhone(phone), version: sql`${warehouses.version} + 1`, updated_at: now() }).where(eq(warehouses.id, pickupId));
    return { message: "Warehouse pickup contact saved." };
  }

  static async warehouses(page: number, search: string, actor: Actor) {
    const scope = await staffWarehouse(actor);
    const where = and(activeWarehouse(), scope === undefined ? undefined : eq(warehouses.id, scope), search.trim() ? ilike(warehouses.name, `%${search.trim()}%`) : undefined);
    const [rows, totals] = await Promise.all([
      db.select({ id: warehouses.id, name: warehouses.name, street_address: warehouses.street_address, city: warehouses.city, state: warehouses.state, zip_code: warehouses.zip_code, phone_number: warehouses.phone_number, latitude: warehouses.latitude, longitude: warehouses.longitude }).from(warehouses).where(where).orderBy(desc(warehouses.id)).limit(10).offset(page * 10),
      db.select({ total: count() }).from(warehouses).where(where),
    ]);
    return { rows, total: totals[0]?.total ?? 0 };
  }

  static async pickupWarehouses(id: number, page: number, search: string, actor: Actor) {
    await this.order(id, actor);
    return this.warehouses(page, search, actor);
  }

  static async setPickupWarehouse(id: number, version: number, warehouseId: number, actor: Actor) {
    await this.order(id, actor);
    const scope = await staffWarehouse(actor);
    if (scope !== undefined && warehouseId !== scope) throw new WorkflowError("Select your assigned warehouse for pickup.", 403);
    return db.transaction(async tx => {
      const [order] = await tx.select().from(orders).where(eq(orders.id, id)).for("update");
      if (!order || order.version !== version || !["PENDING", "PROCESSING", "SCHEDULING"].includes(order.status)) throw new WorkflowError("Order changed or is already scheduled. Refresh first.");
      await assertNoExternalClaim(tx, id);
      await assertNoInternalClaim(tx, id);
      const [warehouse] = await tx.select().from(warehouses).where(and(eq(warehouses.id, warehouseId), activeWarehouse())).for("share");
      if (!warehouse) throw new WorkflowError("Select an existing, active warehouse.", 404);
      if (!coordinates(warehouse.latitude, warehouse.longitude) || ![warehouse.street_address, warehouse.city, warehouse.state, warehouse.zip_code].every(value => value?.trim())) throw new WorkflowError("Save a complete address and verified coordinates for this warehouse first.");
      internationalPhone(warehouse.phone_number);
      await tx.update(orders).set({ lalamove_pickup_warehouse_id: warehouseId, version: order.version + 1, updated_at: new Date() }).where(eq(orders.id, id));
      await notifyLalamove(tx);
      return { message: "Pickup warehouse saved. Its saved name, address and phone number will be used for new courier bookings." };
    });
  }

  static async route(order: typeof orders.$inferSelect): Promise<Route> {
    const [warehouse] = await db.select().from(warehouses).where(eq(warehouses.id, order.lalamove_pickup_warehouse_id ?? order.warehouse_id));
    const pickup = buildPickupPoint(warehouse);
    const dropoff = coordinates(order.shipping_latitude, order.shipping_longitude);
    if (!dropoff) throw new WorkflowError("Verify warehouse and order destination coordinates first.");
    if (!order.shipping_recipient?.trim() || !order.shipping_address?.trim()) throw new WorkflowError("Saved warehouse name and order recipient/address are required.");
    return {
      pickup,
      dropoff: { address: order.shipping_address, lat: String(dropoff.latitude), lng: String(dropoff.longitude), name: order.shipping_recipient, phone: internationalPhone(order.shipping_phone) },
    };
  }

  static async createQuotation(input: { order_id: number; order_version: number; service_type: string; city: string }, actor: Actor) {
    requireLalamoveBooking();
    const order = await this.order(input.order_id, actor);
    if (order.version !== input.order_version) throw new WorkflowError("Order changed. Refresh first.");
    assertReady(order);
    await assertNoExternalClaim(db, order.id);
    await assertNoInternalClaim(db, order.id);
    const route = await this.route(order);
    const cities = await lalamoveRequest<{ data: { locode: string; services: { key: string }[] }[] }>("GET", "/cities");
    if (!cities.data.some(city => city.locode === input.city && city.services.some(service => service.key === input.service_type))) throw new WorkflowError("Select a supported city and vehicle service.", 400);
    const response = await lalamoveRequest<{ data: LalamoveQuotationResponse }>("POST", "/quotations", {
      data: {
        serviceType: input.service_type,
        language: "en_PH",
        stops: [route.pickup, route.dropoff].map(stop => ({ address: stop.address, coordinates: { lat: stop.lat, lng: stop.lng } })),
      },
    });
    const quote = response.data;
    if (typeof quote?.quotationId !== "string" || !quote.expiresAt || typeof quote.stops?.[0]?.stopId !== "string" || typeof quote.stops?.[1]?.stopId !== "string" || !Number.isFinite(Date.parse(quote.expiresAt))) throw new WorkflowError("Lalamove returned an invalid quotation.", 502);
    const config = lalamoveConfig();
    const [stored] = await db.insert(lalamove_quotations).values({
      order_id: order.id,
      pickup_warehouse_id: order.lalamove_pickup_warehouse_id ?? order.warehouse_id,
      order_ids: [order.id],
      order_versions: { [String(order.id)]: order.version },
      is_route_optimized: false,
      booked_by: Number(actor.sub),
      order_version: order.version,
      environment: config.environment,
      market: config.market,
      fingerprint: fingerprint(route),
      route,
      provider_quote: quote,
      expires_at: new Date(quote.expiresAt),
    }).returning();
    return { quotation_ref: stored.id, ...quote, route };
  }

  static async createMultiStopQuotation(
    input: {
      order_ids: number[];
      order_versions: Record<string, number>;
      pickup_warehouse_id: number;
      service_type: string;
      city: string;
      is_route_optimized?: boolean;
    },
    actor: Actor,
  ) {
    requireLalamoveBooking();
    const scope = await staffWarehouse(actor);
    if (!input.order_ids.length || input.order_ids.length > MAX_LALAMOVE_DROPOFF_STOPS) {
      throw new WorkflowError(`Select between 1 and ${MAX_LALAMOVE_DROPOFF_STOPS} orders for Lalamove delivery.`, 400);
    }
    if (new Set(input.order_ids).size !== input.order_ids.length) {
      throw new WorkflowError("Each order can only appear once in a multi-stop booking.", 400);
    }
    if (scope !== undefined && input.pickup_warehouse_id !== scope) {
      throw new WorkflowError("Select your assigned warehouse for pickup.", 403);
    }
    const [warehouse] = await db.select().from(warehouses).where(and(eq(warehouses.id, input.pickup_warehouse_id), activeWarehouse()));
    if (!warehouse) throw new WorkflowError("Select an existing, active warehouse.", 404);
    const pickup = buildPickupPoint(warehouse);

    const rows = await db.select().from(orders).where(inArray(orders.id, input.order_ids));
    const orderById = new Map(rows.map(row => [row.id, row]));
    const dropoffs: MultiStopDropoff[] = [];
    for (const orderId of input.order_ids) {
      const order = orderById.get(orderId);
      if (!order || (scope !== undefined && order.warehouse_id !== scope)) {
        throw new WorkflowError("One or more selected orders were not found in your warehouse.", 404);
      }
      if (order.version !== input.order_versions[String(orderId)]) {
        throw new WorkflowError(`Order ${order.order_number} changed. Refresh first.`);
      }
      assertReady(order);
      await assertNoExternalClaim(db, order.id);
      await assertNoInternalClaim(db, order.id);
      dropoffs.push(buildDropoffPoint(order));
    }

    const cities = await lalamoveRequest<{ data: { locode: string; services: { key: string }[] }[] }>("GET", "/cities");
    if (!cities.data.some(city => city.locode === input.city && city.services.some(service => service.key === input.service_type))) {
      throw new WorkflowError("Select a supported city and vehicle service.", 400);
    }

    const optimize = Boolean(input.is_route_optimized && dropoffs.length > 1);
    const response = await lalamoveRequest<{ data: LalamoveQuotationResponse }>("POST", "/quotations", {
      data: {
        serviceType: input.service_type,
        language: "en_PH",
        ...(optimize ? { isRouteOptimized: true } : {}),
        stops: [
          { address: pickup.address, coordinates: { lat: pickup.lat, lng: pickup.lng } },
          ...dropoffs.map(stop => ({ address: stop.address, coordinates: { lat: stop.lat, lng: stop.lng } })),
        ],
      },
    });
    const quote = response.data;
    if (
      typeof quote?.quotationId !== "string" ||
      !quote.expiresAt ||
      !Number.isFinite(Date.parse(quote.expiresAt)) ||
      !Array.isArray(quote.stops) ||
      quote.stops.length !== 1 + dropoffs.length ||
      quote.stops.some(stop => typeof stop?.stopId !== "string" || !stop.stopId)
    ) {
      throw new WorkflowError("Lalamove returned an invalid multi-stop quotation.", 502);
    }

    const { dropoffs: finalizedDropoffs, reordered } = matchProviderDropoffs(dropoffs, quote.stops.slice(1), optimize);
    const finalizedOrderIds = finalizedDropoffs.map(d => d.order_id);
    const finalizedRoute: MultiStopRoute = { pickup, dropoffs: finalizedDropoffs };
    const config = lalamoveConfig();
    const firstOrder = orderById.get(finalizedOrderIds[0]);
    if (!firstOrder) throw new WorkflowError("Unable to resolve primary order for quotation.");

    const [stored] = await db.insert(lalamove_quotations).values({
      order_id: firstOrder.id,
      pickup_warehouse_id: warehouse.id,
      order_ids: finalizedOrderIds,
      order_versions: Object.fromEntries(finalizedOrderIds.map(id => [String(id), orderById.get(id)?.version ?? 1])),
      is_route_optimized: optimize,
      booked_by: Number(actor.sub),
      order_version: firstOrder.version,
      environment: config.environment,
      market: config.market,
      fingerprint: fingerprint(stripStopIds(finalizedRoute)),
      route: finalizedRoute,
      provider_quote: quote,
      expires_at: new Date(quote.expiresAt),
    }).returning();

    return {
      quotation_ref: stored.id,
      ...quote,
      is_route_optimized: optimize,
      route_reordered: reordered,
      pickup_warehouse_id: warehouse.id,
      route: finalizedRoute,
    };
  }

  static async placeOrder(input: { order_id: number; order_version: number; quotation_ref: string; idempotency_key: string; package_confirmed: boolean }, actor: Actor) {
    requireLalamoveBooking();
    await this.order(input.order_id, actor);
    if (!input.package_confirmed) throw new WorkflowError("Confirm package suitability for the selected vehicle.");
    const requestFingerprint = fingerprint({ order: input.order_id, quote: input.quotation_ref, version: input.order_version });
    const claimed = await db.transaction(async tx => {
      const [order] = await tx.select().from(orders).where(eq(orders.id, input.order_id)).for("update");
      const [existing] = await tx.select().from(delivery_orders).where(eq(delivery_orders.idempotency_key, input.idempotency_key));
      if (existing) {
        if (existing.order_id !== order?.id || existing.request_fingerprint !== requestFingerprint) throw new WorkflowError("This confirmation key belongs to another request.");
        return { booking: existing, submit: false };
      }
      if (!order || order.version !== input.order_version) throw new WorkflowError("Order changed. Request a new quotation.");
      assertReady(order);
      await assertNoExternalClaim(tx, order.id);
      await assertNoInternalClaim(tx, order.id);
      const [quote] = await tx.select().from(lalamove_quotations).where(eq(lalamove_quotations.id, input.quotation_ref));
      const config = lalamoveConfig();
      if (!quote || quote.order_id !== order.id || quote.booked_by !== Number(actor.sub) || quote.order_version !== order.version || quote.environment !== config.environment || quote.market !== config.market || quote.expires_at.getTime() <= Date.now()) throw new WorkflowError("Quotation is expired or belongs to another order/user. Request a fresh quote.");
      const route = await this.route(order);
      if (fingerprint(route) !== quote.fingerprint) throw new WorkflowError("Route or pickup contact changed. Request a new quotation.");
      const provider = quote.provider_quote as LalamoveQuotationResponse;
      const pickupWarehouseId = order.lalamove_pickup_warehouse_id ?? order.warehouse_id;
      const [booking] = await tx.insert(delivery_orders).values({
        order_id: order.id,
        pickup_warehouse_id: pickupWarehouseId,
        is_route_optimized: false,
        stop_count: 1,
        booked_by: Number(actor.sub),
        environment: config.environment,
        market: config.market,
        quotation_id: provider.quotationId,
        booking_state: "CREATING",
        active: true,
        idempotency_key: input.idempotency_key,
        request_fingerprint: requestFingerprint,
        service_type: provider.serviceType,
        route_snapshot: { route, stops: provider.stops },
        recipient_name: route.dropoff.name,
        recipient_phone: route.dropoff.phone,
        pickup_address: route.pickup.address,
        dropoff_address: route.dropoff.address,
        status: "PENDING",
        delivery_fee: provider.priceBreakdown?.total,
        currency: provider.priceBreakdown?.currency,
      }).returning();
      await tx.insert(delivery_order_stops).values({
        booking_id: booking.id,
        order_id: order.id,
        stop_index: 1,
        lalamove_stop_id: provider.stops[1]?.stopId ?? null,
        recipient_name: route.dropoff.name,
        recipient_phone: route.dropoff.phone,
        dropoff_address: route.dropoff.address,
        dropoff_lat: route.dropoff.lat,
        dropoff_lng: route.dropoff.lng,
        active: true,
      });
      return { booking, submit: true };
    });
    if (!claimed.submit) {
      const stopsMap = await this.loadBookingStops([claimed.booking.id]);
      return this.summary(claimed.booking, stopsMap.get(claimed.booking.id));
    }
    const booking = claimed.booking;
    const snapshot = booking.route_snapshot as { route: Route; stops: LalamoveQuotationResponse["stops"] };
    let placed: PlaceOrderResponse | undefined;
    try {
      placed = (await lalamoveRequest<{ data: PlaceOrderResponse }>("POST", "/orders", {
        data: {
          quotationId: booking.quotation_id,
          sender: { stopId: snapshot.stops[0].stopId, name: snapshot.route.pickup.name, phone: snapshot.route.pickup.phone },
          recipients: [{ stopId: snapshot.stops[1].stopId, name: snapshot.route.dropoff.name, phone: snapshot.route.dropoff.phone }],
          isPODEnabled: true,
          metadata: { source: "HYOps", orderId: String(input.order_id), bookingId: String(booking.id) },
        },
      })).data;
      if (typeof placed?.orderId !== "string") throw new Error("Missing provider ID");
      const confirmed = placed;
      // Persist the external identity before stock/status side effects, making recovery possible.
      await db.transaction(async tx => {
        const [current] = await tx.select().from(delivery_orders).where(eq(delivery_orders.id, booking.id)).for("update");
        if (!current.lalamove_order_id || current.lalamove_order_id === confirmed.orderId) {
          await tx.update(delivery_orders).set({ lalamove_order_id: confirmed.orderId, booking_state: "CONFIRMED", lalamove_response: confirmed, updated_at: now() }).where(eq(delivery_orders.id, booking.id));
        }
        await tx.insert(lalamove_provider_ids).values({ identity: identity(confirmed.orderId), booking_id: booking.id }).onConflictDoNothing();
      });
      await this.apply(booking.id, placed, new Date());
    } catch (error) {
      const definitive = !placed && error instanceof LalamoveError && !error.uncertain;
      if (placed?.orderId) console.error(`Lalamove booking ${booking.id} requires reconciliation; provider reference ${placed.orderId}.`);
      await db.transaction(async tx => {
        const [current] = await tx.select().from(delivery_orders).where(eq(delivery_orders.id, booking.id)).for("update");
        // A concurrent callback may already have completed or replaced this job.
        if (current.completed_at || current.booking_state === "RESOLVED" || (placed?.orderId && current.lalamove_order_id && current.lalamove_order_id !== placed.orderId)) return;
        await tx.update(delivery_orders).set({
          booking_state: definitive ? "FAILED" : "UNKNOWN",
          active: !definitive,
          lalamove_order_id: current.lalamove_order_id ?? placed?.orderId ?? null,
          failure_message: definitive ? (error as Error).message : "Booking outcome needs reconciliation. Do not book again.",
          updated_at: now(),
        }).where(eq(delivery_orders.id, booking.id));
        await tx.update(delivery_order_stops).set({ active: !definitive, updated_at: new Date() }).where(eq(delivery_order_stops.booking_id, booking.id));
      });
    }
    const latest = await this.booking(booking.id, actor);
    const stopsMap = await this.loadBookingStops([latest.id]);
    return this.summary(latest, stopsMap.get(latest.id));
  }

  static async placeMultiStopOrder(
    input: {
      order_ids: number[];
      order_versions: Record<string, number>;
      pickup_warehouse_id: number;
      quotation_ref: string;
      idempotency_key: string;
      package_confirmed: boolean;
    },
    actor: Actor,
  ) {
    requireLalamoveBooking();
    const scope = await staffWarehouse(actor);
    if (!input.package_confirmed) throw new WorkflowError("Confirm package suitability for the selected vehicle.");
    if (!input.order_ids.length || input.order_ids.length > MAX_LALAMOVE_DROPOFF_STOPS) {
      throw new WorkflowError(`Select between 1 and ${MAX_LALAMOVE_DROPOFF_STOPS} orders.`, 400);
    }
    if (new Set(input.order_ids).size !== input.order_ids.length) {
      throw new WorkflowError("Each order can only appear once in a multi-stop booking.", 400);
    }
    if (scope !== undefined && input.pickup_warehouse_id !== scope) {
      throw new WorkflowError("Select your assigned warehouse for pickup.", 403);
    }

    const sortedOrderIds = [...input.order_ids].sort((a, b) => a - b);
    const requestFingerprint = fingerprint({
      orders: sortedOrderIds,
      versions: Object.fromEntries(sortedOrderIds.map(id => [String(id), input.order_versions[String(id)]])),
      pickup_warehouse_id: input.pickup_warehouse_id,
      quote: input.quotation_ref,
    });

    const claimed = await db.transaction(async tx => {
      const lockedOrders = await tx.select().from(orders).where(inArray(orders.id, sortedOrderIds)).orderBy(asc(orders.id)).for("update");
      const [existing] = await tx.select().from(delivery_orders).where(eq(delivery_orders.idempotency_key, input.idempotency_key));
      if (existing) {
        if (existing.request_fingerprint !== requestFingerprint) {
          throw new WorkflowError("This confirmation key belongs to another request.");
        }
        return { booking: existing, submit: false };
      }

      if (lockedOrders.length !== sortedOrderIds.length) {
        throw new WorkflowError("One or more selected orders were not found.", 404);
      }
      const orderById = new Map(lockedOrders.map(row => [row.id, row]));

      const [quote] = await tx.select().from(lalamove_quotations).where(eq(lalamove_quotations.id, input.quotation_ref));
      const config = lalamoveConfig();
      const quoteOrderIds = quote?.order_ids ?? (quote ? [quote.order_id] : []);
      const sortedQuoteOrderIds = [...quoteOrderIds].sort((a, b) => a - b);
      if (
        !quote ||
        quote.booked_by !== Number(actor.sub) ||
        quote.environment !== config.environment ||
        quote.market !== config.market ||
        quote.expires_at.getTime() <= Date.now() ||
        quote.pickup_warehouse_id !== input.pickup_warehouse_id ||
        sortedQuoteOrderIds.length !== sortedOrderIds.length ||
        sortedQuoteOrderIds.some((id, idx) => id !== sortedOrderIds[idx])
      ) {
        throw new WorkflowError("Quotation is expired or belongs to another set of orders/user. Request a fresh quote.");
      }

      const [warehouse] = await tx.select().from(warehouses).where(and(eq(warehouses.id, input.pickup_warehouse_id), activeWarehouse())).for("share");
      if (!warehouse) throw new WorkflowError("Select an existing, active warehouse.", 404);
      const pickup = buildPickupPoint(warehouse);

      const quoteVersions = quote.order_versions ?? { [String(quote.order_id)]: quote.order_version };
      const liveDropoffs: MultiStopDropoff[] = [];
      for (const orderId of quoteOrderIds) {
        const order = orderById.get(orderId);
        if (!order || (scope !== undefined && order.warehouse_id !== scope)) {
          throw new WorkflowError("One or more selected orders were not found in your warehouse.", 404);
        }
        if (order.version !== input.order_versions[String(orderId)] || order.version !== quoteVersions[String(orderId)]) {
          throw new WorkflowError(`Order ${order.order_number} changed. Request a new quotation.`);
        }
        assertReady(order);
        await assertNoExternalClaim(tx, order.id);
        await assertNoInternalClaim(tx, order.id);
        liveDropoffs.push(buildDropoffPoint(order));
      }

      if (fingerprint(stripStopIds({ pickup, dropoffs: liveDropoffs })) !== quote.fingerprint) {
        throw new WorkflowError("Route or pickup contact changed. Request a new quotation.");
      }

      const provider = quote.provider_quote as LalamoveQuotationResponse;
      const storedRoute = quote.route as MultiStopRoute;
      const stopIdByOrderId = new Map((storedRoute.dropoffs ?? []).map(d => [d.order_id, d.stop_id]));
      const finalizedDropoffs = liveDropoffs.map((d, idx) => ({
        ...d,
        stop_id: stopIdByOrderId.get(d.order_id) ?? provider.stops[idx + 1]?.stopId,
      }));
      const firstDropoff = finalizedDropoffs[0];
      const dropoffSummary = finalizedDropoffs.length === 1
        ? firstDropoff.address
        : `${firstDropoff.address} (+${finalizedDropoffs.length - 1} more ${finalizedDropoffs.length - 1 === 1 ? "stop" : "stops"})`;

      const [booking] = await tx.insert(delivery_orders).values({
        order_id: firstDropoff.order_id,
        pickup_warehouse_id: warehouse.id,
        is_route_optimized: quote.is_route_optimized,
        stop_count: finalizedDropoffs.length,
        booked_by: Number(actor.sub),
        environment: config.environment,
        market: config.market,
        quotation_id: provider.quotationId,
        booking_state: "CREATING",
        active: true,
        idempotency_key: input.idempotency_key,
        request_fingerprint: requestFingerprint,
        service_type: provider.serviceType,
        route_snapshot: { pickup, dropoffs: finalizedDropoffs, stops: provider.stops },
        recipient_name: firstDropoff.name,
        recipient_phone: firstDropoff.phone,
        pickup_address: pickup.address,
        dropoff_address: dropoffSummary,
        status: "PENDING",
        delivery_fee: provider.priceBreakdown?.total,
        currency: provider.priceBreakdown?.currency,
      }).returning();

      await tx.insert(delivery_order_stops).values(
        finalizedDropoffs.map((d, idx) => ({
          booking_id: booking.id,
          order_id: d.order_id,
          stop_index: idx + 1,
          lalamove_stop_id: d.stop_id ?? null,
          recipient_name: d.name,
          recipient_phone: d.phone,
          dropoff_address: d.address,
          dropoff_lat: d.lat,
          dropoff_lng: d.lng,
          active: true,
        })),
      );

      return { booking, submit: true };
    });

    if (!claimed.submit) {
      const stopsMap = await this.loadBookingStops([claimed.booking.id]);
      return this.summary(claimed.booking, stopsMap.get(claimed.booking.id));
    }

    const booking = claimed.booking;
    const snapshot = booking.route_snapshot as { pickup: StopPoint; dropoffs: MultiStopDropoff[]; stops: LalamoveQuotationResponse["stops"] };
    let placed: PlaceOrderResponse | undefined;
    try {
      placed = (await lalamoveRequest<{ data: PlaceOrderResponse }>("POST", "/orders", {
        data: {
          quotationId: booking.quotation_id,
          sender: { stopId: snapshot.stops[0].stopId, name: snapshot.pickup.name, phone: snapshot.pickup.phone },
          recipients: snapshot.dropoffs.map((d, idx) => ({
            stopId: d.stop_id ?? snapshot.stops[idx + 1].stopId,
            name: d.name,
            phone: d.phone,
            remarks: `HYOps Order ${d.order_number}`,
          })),
          isPODEnabled: true,
          metadata: {
            source: "HYOps",
            orderId: String(booking.order_id),
            orderIds: snapshot.dropoffs.map(d => d.order_id).join(","),
            bookingId: String(booking.id),
          },
        },
      })).data;
      if (typeof placed?.orderId !== "string") throw new Error("Missing provider ID");
      const confirmed = placed;
      await db.transaction(async tx => {
        const [current] = await tx.select().from(delivery_orders).where(eq(delivery_orders.id, booking.id)).for("update");
        if (!current.lalamove_order_id || current.lalamove_order_id === confirmed.orderId) {
          await tx.update(delivery_orders).set({ lalamove_order_id: confirmed.orderId, booking_state: "CONFIRMED", lalamove_response: confirmed, updated_at: now() }).where(eq(delivery_orders.id, booking.id));
        }
        await tx.insert(lalamove_provider_ids).values({ identity: identity(confirmed.orderId), booking_id: booking.id }).onConflictDoNothing();
      });
      await this.apply(booking.id, placed, new Date());
    } catch (error) {
      const definitive = !placed && error instanceof LalamoveError && !error.uncertain;
      if (placed?.orderId) console.error(`Lalamove booking ${booking.id} requires reconciliation; provider reference ${placed.orderId}.`);
      await db.transaction(async tx => {
        const [current] = await tx.select().from(delivery_orders).where(eq(delivery_orders.id, booking.id)).for("update");
        if (current.completed_at || current.booking_state === "RESOLVED" || (placed?.orderId && current.lalamove_order_id && current.lalamove_order_id !== placed.orderId)) return;
        await tx.update(delivery_orders).set({
          booking_state: definitive ? "FAILED" : "UNKNOWN",
          active: !definitive,
          lalamove_order_id: current.lalamove_order_id ?? placed?.orderId ?? null,
          failure_message: definitive ? (error as Error).message : "Booking outcome needs reconciliation. Do not book again.",
          updated_at: now(),
        }).where(eq(delivery_orders.id, booking.id));
        await tx.update(delivery_order_stops).set({ active: !definitive, updated_at: new Date() }).where(eq(delivery_order_stops.booking_id, booking.id));
      });
    }

    const latest = await this.booking(booking.id, actor);
    const stopsMap = await this.loadBookingStops([latest.id]);
    return this.summary(latest, stopsMap.get(latest.id));
  }

  static async apply(id: number, provider: PlaceOrderResponse, fetchedAt: Date) {
    return stockTransaction(async tx => {
      const [initial] = await tx.select().from(delivery_orders).where(eq(delivery_orders.id, id));
      if (!initial?.order_id) throw new WorkflowError("Unlinked external booking.");
      const stopRows = await tx
        .select()
        .from(delivery_order_stops)
        .where(eq(delivery_order_stops.booking_id, id))
        .orderBy(asc(delivery_order_stops.stop_index), asc(delivery_order_stops.id));

      const linkedOrderIds = Array.from(new Set(stopRows.length ? stopRows.map(s => s.order_id) : [initial.order_id])).sort((a, b) => a - b);
      const lockedOrders = await tx.select().from(orders).where(inArray(orders.id, linkedOrderIds)).orderBy(asc(orders.id)).for("update");
      const orderById = new Map(lockedOrders.map(row => [row.id, row]));

      const [booking] = await tx.select().from(delivery_orders).where(eq(delivery_orders.id, id)).for("update");
      if (booking.last_synced_at && booking.last_synced_at > fetchedAt) return;
      if (provider.orderId !== booking.lalamove_order_id) throw new WorkflowError("Provider booking identity mismatch.");
      const status = provider.status;

      if (!booking.active && terminalStatuses.has(booking.status) && terminalStatuses.has(status)) {
        // A late callback for an ended attempt must not reclaim orders that may be rebooked.
        await tx.update(delivery_orders).set({
          status,
          lalamove_response: provider,
          last_synced_at: fetchedAt,
          updated_at: now(),
          delivery_fee: provider.priceBreakdown?.total ?? booking.delivery_fee,
        }).where(eq(delivery_orders.id, id));
        return;
      }

      const [otherOwner] = await tx
        .select({ id: delivery_orders.id })
        .from(delivery_orders)
        .where(and(inArray(delivery_orders.order_id, linkedOrderIds), eq(delivery_orders.active, true)))
        .limit(1);
      if (otherOwner && otherOwner.id !== id) throw new WorkflowError("Another booking owns one of these orders. Review the provider event before applying it.");
      const [otherStopOwner] = await tx
        .select({ booking_id: delivery_order_stops.booking_id })
        .from(delivery_order_stops)
        .where(and(inArray(delivery_order_stops.order_id, linkedOrderIds), eq(delivery_order_stops.active, true)))
        .limit(1);
      if (otherStopOwner && otherStopOwner.booking_id !== id) throw new WorkflowError("Another booking owns one of these orders. Review the provider event before applying it.");

      let pickedUp = booking.picked_up_at;
      let completed = booking.completed_at;
      let active = booking.active;
      let state = "CONFIRMED";
      let failure: string | null = null;

      if (["PICKED_UP", "COMPLETED"].includes(status) && !pickedUp) {
        for (const order of lockedOrders) {
          if (!order.stock_reserved || !["SCHEDULING", "SCHEDULED"].includes(order.status)) {
            throw new WorkflowError("Pickup needs stock/custody reconciliation.");
          }
        }
        for (const order of lockedOrders) {
          await changeOrderStock(tx, order.id, order.warehouse_id, "consume");
        }
        pickedUp = new Date();
      }

      if (status === "COMPLETED") {
        completed ??= new Date();
        active = false;
      } else if (pickedUp && !completed) {
        active = true;
      } else if (["ASSIGNING_DRIVER", "ON_GOING"].includes(status) && !completed) {
        active = true;
      }

      if (terminalStatuses.has(status) && !completed) {
        if (pickedUp || status === "CANCELED") {
          state = "REVIEW";
          active = true;
          failure = pickedUp
            ? "Goods were picked up. Confirm custody/return before resolving."
            : "Confirm cancellation or provider replacement before releasing this order.";
        } else {
          active = false;
        }
      }

      if (!["ASSIGNING_DRIVER", "ON_GOING", "PICKED_UP", "COMPLETED", ...terminalStatuses].includes(status)) {
        state = "REVIEW";
        active = true;
        failure = "Unrecognized provider status. Review required.";
      }

      const providerStopById = new Map((provider.stops ?? []).map(s => [s.stopId, s]));
      const deliveredOrderIds = new Set<number>();

      if (stopRows.length > 0) {
        for (const stop of stopRows) {
          const pStop =
            (stop.lalamove_stop_id ? providerStopById.get(stop.lalamove_stop_id) : undefined) ??
            provider.stops?.[stop.stop_index];
          const nextPodStatus = pStop?.POD?.status ?? stop.pod_status;
          const podDelivered = nextPodStatus === "DELIVERED" || nextPodStatus === "SIGNED";
          const stopIsDelivered = status === "COMPLETED" || (Boolean(pickedUp) && podDelivered);
          const parsedDeliveredAt = pStop?.POD?.deliveredAt && Number.isFinite(Date.parse(pStop.POD.deliveredAt))
            ? new Date(pStop.POD.deliveredAt)
            : null;
          const nextDeliveredAt = stop.delivered_at ?? (stopIsDelivered ? (parsedDeliveredAt ?? completed ?? new Date()) : null);

          if (stopIsDelivered) {
            deliveredOrderIds.add(stop.order_id);
            if (!stop.delivered_at) {
              await queueExternalDeliveryNotification(tx, id, stop.order_id, stop.id);
            }
          }

          await tx.update(delivery_order_stops).set({
            lalamove_stop_id: stop.lalamove_stop_id ?? pStop?.stopId ?? null,
            pod_status: nextPodStatus ?? null,
            delivered_at: nextDeliveredAt,
            active,
            updated_at: new Date(),
          }).where(eq(delivery_order_stops.id, stop.id));
        }
      } else if (status === "COMPLETED") {
        // Legacy fallback for rows created prior to delivery_order_stops.
        deliveredOrderIds.add(initial.order_id);
        if (!booking.completed_at) await queueExternalDeliveryNotification(tx, id, initial.order_id);
      }

      if (booking.status !== status || (provider.priceBreakdown?.total && provider.priceBreakdown.total !== booking.delivery_fee)) {
        await tx.insert(lalamove_events).values({
          environment: booking.environment,
          dedupe_key: `sync:${id}:${fetchedAt.toISOString()}:${status}`,
          event_type: "HYOPS_PROVIDER_SYNC",
          provider_order_id: provider.orderId,
          state: "PROCESSED",
          processed_at: new Date(),
          payload: {
            previousStatus: booking.status,
            status,
            previousCost: booking.delivery_fee,
            cost: provider.priceBreakdown?.total ?? booking.delivery_fee,
            currency: provider.priceBreakdown?.currency ?? booking.currency,
          },
        }).onConflictDoNothing();
      }

      await tx.update(delivery_orders).set({
        status,
        booking_state: state,
        active,
        picked_up_at: pickedUp,
        completed_at: completed,
        lalamove_response: provider,
        share_link: safeTrackingLink(provider.shareLink),
        driver_id: provider.driverId ?? null,
        ...(booking.driver_id !== (provider.driverId ?? null) ? { driver_details: null } : {}),
        delivery_fee: provider.priceBreakdown?.total ?? booking.delivery_fee,
        currency: provider.priceBreakdown?.currency ?? booking.currency,
        last_synced_at: fetchedAt,
        failure_message: failure,
        updated_at: now(),
      }).where(eq(delivery_orders.id, id));

      for (const order of lockedOrders) {
        let nextOrderStatus = order.status;
        if (status === "COMPLETED" || deliveredOrderIds.has(order.id)) {
          nextOrderStatus = "COMPLETED";
        } else if (pickedUp && !completed) {
          nextOrderStatus = "IN_TRANSIT";
        } else if (["ASSIGNING_DRIVER", "ON_GOING"].includes(status) && !completed) {
          nextOrderStatus = "SCHEDULED";
        } else if (terminalStatuses.has(status) && !completed && !pickedUp && status !== "CANCELED") {
          nextOrderStatus = "SCHEDULING";
        }

        if (order.status !== nextOrderStatus) {
          await tx.update(orders).set({ status: nextOrderStatus, version: order.version + 1, updated_at: new Date() }).where(eq(orders.id, order.id));
        }
      }

      await notifyLalamove(tx);
    });
  }

  static async refresh(id: number, actor?: Actor) {
    const booking = actor ? await this.booking(id, actor) : (await db.select().from(delivery_orders).where(eq(delivery_orders.id, id)))[0];
    if (!booking) throw new WorkflowError("Booking not found.", 404);
    this.assertEnvironment(booking);
    if (!booking.lalamove_order_id) throw new WorkflowError("Provider identity is unknown. Reconcile in Partner Portal before retrying.");
    if (actor && booking.last_synced_at && Date.now() - booking.last_synced_at.getTime() < 5000) {
      const stopsMap = await this.loadBookingStops([booking.id]);
      return this.summary(booking, stopsMap.get(booking.id));
    }
    const fetchedAt = new Date();
    const response = await lalamoveRequest<{ data: PlaceOrderResponse }>("GET", `/orders/${encodeURIComponent(booking.lalamove_order_id)}`);
    await this.apply(id, response.data, fetchedAt);
    if (response.data.driverId) {
      try {
        const driver = await lalamoveRequest<{ data: unknown }>("GET", `/orders/${encodeURIComponent(booking.lalamove_order_id)}/drivers/${encodeURIComponent(response.data.driverId)}`);
        await db.update(delivery_orders).set({ driver_details: driver.data }).where(and(eq(delivery_orders.id, id), eq(delivery_orders.driver_id, response.data.driverId)));
      } catch { /* Order refresh succeeds even if driver detail is temporarily unavailable. */ }
    }
    const [latest] = await db.select().from(delivery_orders).where(eq(delivery_orders.id, id));
    const stopsMap = await this.loadBookingStops([id]);
    return this.summary(latest, stopsMap.get(id));
  }

  static async refreshDriverLocation(id: number, actor: Actor) {
    const booking = await this.booking(id, actor);
    this.assertEnvironment(booking);
    let latestDetails = booking.driver_details;
    let syncedAt = booking.last_synced_at;

    const canFetchDriver =
      booking.active &&
      Boolean(booking.lalamove_order_id) &&
      Boolean(booking.driver_id) &&
      ["ON_GOING", "PICKED_UP"].includes(booking.status) &&
      Boolean(process.env.LALAMOVE_API_KEY && process.env.LALAMOVE_API_SECRET) &&
      (!booking.last_synced_at || Date.now() - booking.last_synced_at.getTime() >= 10_000);

    if (canFetchDriver && booking.lalamove_order_id && booking.driver_id) {
      try {
        const fetchedAt = new Date();
        const driver = await lalamoveRequest<{ data: unknown }>(
          "GET",
          `/orders/${encodeURIComponent(booking.lalamove_order_id)}/drivers/${encodeURIComponent(booking.driver_id)}`,
        );
        latestDetails = driver.data;
        syncedAt = fetchedAt;
        await db
          .update(delivery_orders)
          .set({ driver_details: driver.data, last_synced_at: fetchedAt, updated_at: now() })
          .where(and(eq(delivery_orders.id, id), eq(delivery_orders.driver_id, booking.driver_id)));
      } catch {
        // Keep last known driver details when provider rejects outside tracking window (e.g. 403).
      }
    }

    return {
      booking_id: booking.id,
      status: booking.status,
      driver_details: latestDetails,
      driver_coordinates: extractDriverCoordinates(latestDetails),
      last_synced_at: syncedAt,
    };
  }

  static async liveActive(actor: Actor) {
    const scope = await staffWarehouse(actor);
    const config = lalamoveConfig();
    const rows = await db
      .select({
        booking: delivery_orders,
        order_number: orders.order_number,
        order_warehouse_id: orders.warehouse_id,
        order_pickup_warehouse_id: orders.lalamove_pickup_warehouse_id,
      })
      .from(delivery_orders)
      .innerJoin(orders, eq(orders.id, delivery_orders.order_id))
      .where(
        and(
          eq(delivery_orders.active, true),
          eq(delivery_orders.environment, config.environment),
          eq(delivery_orders.market, config.market),
          scope === undefined
            ? undefined
            : or(
                eq(orders.warehouse_id, scope),
                sql`exists (select 1 from delivery_order_stops s inner join orders o on o.id = s.order_id where s.booking_id = ${delivery_orders.id} and o.warehouse_id = ${scope})`,
              ),
        ),
      )
      .orderBy(desc(delivery_orders.id))
      .limit(50);

    if (!rows.length) return [];

    // Throttled live driver coordinate refresh (15s per booking, up to 5 bookings per poll).
    const hasCredentials = Boolean(process.env.LALAMOVE_API_KEY && process.env.LALAMOVE_API_SECRET);
    const updatedDriverMap = new Map<number, { driver_details: unknown; last_synced_at: Date }>();
    if (hasCredentials) {
      const toRefresh = rows
        .map(row => row.booking)
        .filter(
          b =>
            b.lalamove_order_id &&
            b.driver_id &&
            ["ON_GOING", "PICKED_UP"].includes(b.status) &&
            (!b.last_synced_at || Date.now() - b.last_synced_at.getTime() >= 15_000),
        )
        .slice(0, 5);

      await Promise.allSettled(
        toRefresh.map(async (b) => {
          if (!b.lalamove_order_id || !b.driver_id) return;
          const fetchedAt = new Date();
          const driver = await lalamoveRequest<{ data: unknown }>(
            "GET",
            `/orders/${encodeURIComponent(b.lalamove_order_id)}/drivers/${encodeURIComponent(b.driver_id)}`,
          );
          await db
            .update(delivery_orders)
            .set({ driver_details: driver.data, last_synced_at: fetchedAt, updated_at: now() })
            .where(and(eq(delivery_orders.id, b.id), eq(delivery_orders.driver_id, b.driver_id)));
          updatedDriverMap.set(b.id, { driver_details: driver.data, last_synced_at: fetchedAt });
        }),
      );
    }

    const bookingIds = rows.map(r => r.booking.id);
    const stopsMap = await this.loadBookingStops(bookingIds);
    const pickupIds = Array.from(
      new Set(
        rows
          .map(r => r.booking.pickup_warehouse_id ?? r.order_pickup_warehouse_id ?? r.order_warehouse_id)
          .filter((id): id is number => typeof id === "number"),
      ),
    );
    const warehouseRows = pickupIds.length
      ? await db.select().from(warehouses).where(inArray(warehouses.id, pickupIds))
      : [];
    const warehouseById = new Map(warehouseRows.map(w => [w.id, w]));

    return rows.map(({ booking: b, order_number, order_warehouse_id, order_pickup_warehouse_id }) => {
      const refreshed = updatedDriverMap.get(b.id);
      const driverDetails = (refreshed?.driver_details ?? b.driver_details) as {
        name?: string;
        phone?: string;
        plateNumber?: string;
      } | null;
      const lastSyncedAt = refreshed?.last_synced_at ?? b.last_synced_at;
      const pickupWarehouseId = b.pickup_warehouse_id ?? order_pickup_warehouse_id ?? order_warehouse_id;
      const pickupWarehouse = pickupWarehouseId ? warehouseById.get(pickupWarehouseId) : undefined;
      const pickupCoords = pickupWarehouse ? coordinates(pickupWarehouse.latitude, pickupWarehouse.longitude) : null;
      const stops = (stopsMap.get(b.id) ?? []).map((stop) => {
        const parsed = coordinates(stop.dropoff_lat, stop.dropoff_lng);
        return {
          id: stop.id,
          order_id: stop.order_id,
          order_number: stop.order_number,
          order_status: stop.order_status,
          stop_index: stop.stop_index,
          recipient_name: stop.recipient_name,
          dropoff_address: stop.dropoff_address,
          pod_status: stop.pod_status,
          delivered_at: stop.delivered_at,
          coordinates: parsed ? ([Number(parsed.longitude), Number(parsed.latitude)] as [number, number]) : null,
        };
      });

      return {
        booking_id: b.id,
        lalamove_order_id: b.lalamove_order_id,
        status: b.status,
        booking_state: b.booking_state,
        service_type: b.service_type,
        stop_count: stops.length || b.stop_count,
        is_route_optimized: b.is_route_optimized,
        order_id: b.order_id,
        order_number,
        share_link: safeTrackingLink(b.share_link),
        last_synced_at: lastSyncedAt,
        picked_up_at: b.picked_up_at,
        driver: {
          id: b.driver_id,
          name: driverDetails?.name ?? null,
          phone: driverDetails?.phone ?? null,
          plate_number: driverDetails?.plateNumber ?? null,
          coordinates: extractDriverCoordinates(driverDetails),
        },
        pickup: {
          warehouse_id: pickupWarehouse?.id ?? null,
          name: pickupWarehouse?.name ?? null,
          address: b.pickup_address,
          coordinates: pickupCoords ? ([Number(pickupCoords.longitude), Number(pickupCoords.latitude)] as [number, number]) : null,
        },
        stops,
      };
    });
  }

  static async cancel(id: number, actor: Actor) {
    const booking = await this.booking(id, actor);
    this.assertEnvironment(booking);
    if (!booking.lalamove_order_id || !booking.active || booking.picked_up_at) throw new WorkflowError("This booking cannot be canceled here; review its current custody/status.");
    await lalamoveRequest("DELETE", `/orders/${encodeURIComponent(booking.lalamove_order_id)}`);
    await this.refresh(id); // Resolve only after provider confirms the cancellation.
    const current = await this.booking(id, actor);
    if (current.status === "CANCELED" && !current.picked_up_at) await this.resolve(id, "Confirmed staff cancellation through provider API.", actor, undefined, true);
    const latest = await this.booking(id, actor);
    const stopsMap = await this.loadBookingStops([latest.id]);
    return this.summary(latest, stopsMap.get(latest.id));
  }

  static async resolve(id: number, note: string, actor: Actor, providerId?: string, confirmedCancellation = false) {
    const booking = await this.booking(id, actor);
    this.assertEnvironment(booking);
    const orderId = booking.order_id;
    if (!orderId) throw new WorkflowError("Unlinked legacy booking.");
    if (actor.role !== "admin" && !confirmedCancellation) throw new WorkflowError("Administrator reconciliation required.", 403);
    if (providerId) {
      const fetchedAt = new Date();
      const { data } = await lalamoveRequest<{ data: PlaceOrderResponse }>("GET", `/orders/${encodeURIComponent(providerId)}`);
      if (data.metadata?.bookingId !== String(id) || data.metadata?.orderId !== String(booking.order_id)) throw new WorkflowError("Provider metadata does not identify this booking. Contact support.");
      await db.transaction(async tx => {
        const stopRows = await tx.select({ order_id: delivery_order_stops.order_id }).from(delivery_order_stops).where(eq(delivery_order_stops.booking_id, id));
        const linkedIds = Array.from(new Set(stopRows.length ? stopRows.map(s => s.order_id) : [orderId])).sort((a, b) => a - b);
        const locked = await tx.select().from(orders).where(inArray(orders.id, linkedIds)).orderBy(asc(orders.id)).for("update");
        if (!locked.length) throw new WorkflowError("Order not found.");
        await tx.update(delivery_orders).set({ lalamove_order_id: providerId, resolution_note: note }).where(eq(delivery_orders.id, id));
        await tx.insert(lalamove_provider_ids).values({ identity: identity(providerId), booking_id: id }).onConflictDoNothing();
      });
      await this.apply(id, data, fetchedAt);
      return { message: "Provider booking linked and synchronized." };
    }
    await db.transaction(async tx => {
      const stopRows = await tx.select({ order_id: delivery_order_stops.order_id }).from(delivery_order_stops).where(eq(delivery_order_stops.booking_id, id));
      const linkedIds = Array.from(new Set(stopRows.length ? stopRows.map(s => s.order_id) : [orderId])).sort((a, b) => a - b);
      const lockedOrders = await tx.select().from(orders).where(inArray(orders.id, linkedIds)).orderBy(asc(orders.id)).for("update");
      const [current] = await tx.select().from(delivery_orders).where(eq(delivery_orders.id, id)).for("update");
      if (current.picked_up_at) throw new WorkflowError("Post-pickup custody requires a return investigation; this action cannot restore stock.");
      if (!current.active || !["UNKNOWN", "REVIEW"].includes(current.booking_state)) throw new WorkflowError("Only unresolved attempts can be released.");
      if (current.lalamove_order_id && !terminalStatuses.has(current.status)) throw new WorkflowError("Known booking is still active. Refresh/cancel it first.");
      await tx.update(delivery_orders).set({ active: false, booking_state: "RESOLVED", resolution_note: note, updated_at: now() }).where(eq(delivery_orders.id, id));
      await tx.update(delivery_order_stops).set({ active: false, updated_at: new Date() }).where(eq(delivery_order_stops.booking_id, id));
      for (const order of lockedOrders) {
        if (order.status === "SCHEDULED") {
          await tx.update(orders).set({ status: "SCHEDULING", version: order.version + 1, updated_at: new Date() }).where(eq(orders.id, order.id));
        }
      }
      await notifyLalamove(tx);
    });
    return { message: "Attempt resolved. The order may be booked again explicitly." };
  }
}
