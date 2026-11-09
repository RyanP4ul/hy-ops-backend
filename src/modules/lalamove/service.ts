import { and, count, desc, eq, ilike, inArray, sql } from "drizzle-orm";
import { db } from "../../db";
import { orders } from "../../db/schema/order";
import { warehouses } from "../../db/schema/warehouses";
import { delivery_orders, lalamove_events, lalamove_provider_ids, lalamove_quotations } from "../../db/schema/lalamove";
import { LalamoveError, lalamoveConfig, lalamoveRequest, requireLalamoveBooking } from "../../plugins/lalamove";
import { staffWarehouse, type AssignmentActor } from "../deliveries/scope";
import { stockTransaction, type StockTransaction } from "../inventory/transaction";
import { changeOrderStock } from "../order/stock";
import { queueExternalDeliveryNotification } from "../deliveries/notification-queue";
import { WorkflowError } from "../../utils/workflow-error";
import { coordinates } from "../../utils/coordinates";
import { assertNoExternalClaim, assertNoInternalClaim } from "./fulfillment";
import { assertReady, fingerprint, internationalPhone, safeTrackingLink, terminalStatuses } from "./rules";
import type { LalamoveQuotationResponse, PlaceOrderResponse } from "./model";
import { lalamoveCallback } from "./webhook-config";

type Actor = AssignmentActor;
type Route = { pickup: { address: string; lat: string; lng: string; name: string; phone: string }; dropoff: { address: string; lat: string; lng: string; name: string; phone: string } };
const now = () => Math.floor(Date.now() / 1000);
const identity = (id: string) => `${lalamoveConfig().environment}:${lalamoveConfig().market}:${id}`;
export async function notifyLalamove(tx: StockTransaction) {
  for (const resource of ["orders", "deliveries", "inventory", "lalamove", "reports"]) {
    await tx.execute(sql`select pg_notify('hyops_resource_changed', ${JSON.stringify({ type: "RESOURCE_CHANGED", payload: { resource, eventId: crypto.randomUUID() } })})`);
  }
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
    return { enabled: process.env.LALAMOVE_ENABLED === "true", environment: config.environment, can_manage: true,
      callback_url: callback.url, callback_path: callback.path, last_callback_at: event?.received_at ?? null };
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
    return db.select({ id: orders.id, order_number: orders.order_number, delivery_method: orders.delivery_method, shipping_address: orders.shipping_address })
      .from(orders).where(and(eq(orders.status, "SCHEDULING"), scope === undefined ? undefined : eq(orders.warehouse_id, scope))).orderBy(desc(orders.id)).limit(100);
  }
  static async order(id: number, actor: Actor) {
    const scope = await staffWarehouse(actor);
    const [order] = await db.select().from(orders).where(and(eq(orders.id, id), scope === undefined ? undefined : eq(orders.warehouse_id, scope)));
    if (!order) throw new WorkflowError("Order not found in your warehouse.", 404);
    return order;
  }
  static async booking(id: number, actor: Actor) {
    const [booking] = await db.select().from(delivery_orders).where(eq(delivery_orders.id, id));
    if (!booking?.order_id) throw new WorkflowError("Order-linked booking not found.", 404);
    await this.order(booking.order_id, actor);
    return booking;
  }
  static assertEnvironment(booking: typeof delivery_orders.$inferSelect) {
    const config = lalamoveConfig();
    if (booking.environment !== config.environment || booking.market !== config.market) throw new WorkflowError("Switch to this booking's provider environment before synchronizing it.");
  }
  static async context(id: number, actor: Actor) {
    const order = await this.order(id, actor);
    const [warehouse] = await db.select().from(warehouses).where(eq(warehouses.id, order.lalamove_pickup_warehouse_id ?? order.warehouse_id));
    const bookings = await db.select().from(delivery_orders).where(eq(delivery_orders.order_id, id)).orderBy(desc(delivery_orders.id));
    const aliases = bookings.length ? await db.select().from(lalamove_provider_ids).where(inArray(lalamove_provider_ids.booking_id, bookings.map(row => row.id))) : [];
    const config = lalamoveConfig();
    const providerIds = aliases.filter(alias => alias.identity.startsWith(`${config.environment}:${config.market}:`)).map(alias => alias.identity.split(":").slice(2).join(":"));
    const history = providerIds.length ? await db.select({ id: lalamove_events.id, event_type: lalamove_events.event_type, state: lalamove_events.state, created_at: lalamove_events.created_at, last_error: lalamove_events.last_error })
      .from(lalamove_events).where(and(eq(lalamove_events.environment, lalamoveConfig().environment), inArray(lalamove_events.provider_order_id, providerIds))).orderBy(desc(lalamove_events.created_at)).limit(100) : [];
    let eligible = true; let reason: string | null = null;
    try { assertReady(order); await this.route(order); } catch (e) { eligible = false; reason = e instanceof Error ? e.message : "Order is not ready."; }
    return { order, warehouse, bookings: bookings.map(this.summary), history, eligible, reason, can_reconcile: actor.role === "admin",
      ...lalamoveConfig(), base: undefined, enabled: process.env.LALAMOVE_ENABLED === "true" };
  }
  static summary(row: typeof delivery_orders.$inferSelect) {
    // Keep raw provider responses, route PII, and delivery codes off list/history contracts.
    const { lalamove_response: _raw, route_snapshot: _route, request_fingerprint: _fingerprint, ...summary } = row;
    const response = row.lalamove_response as PlaceOrderResponse | null;
    const evidence = response?.stops?.flatMap(stop => stop.POD ? [{ stop_id: stop.stopId, status: stop.POD.status ?? "PENDING", delivered_at: stop.POD.deliveredAt ?? null }] : []) ?? [];
    return { ...summary, evidence, share_link: safeTrackingLink(row.share_link) };
  }
  static async list(actor: Actor, page = 0) {
    const scope = await staffWarehouse(actor);
    return db.select({ booking: delivery_orders, order_number: orders.order_number }).from(delivery_orders)
      .innerJoin(orders, eq(orders.id, delivery_orders.order_id))
      .where(scope === undefined ? undefined : eq(orders.warehouse_id, scope)).orderBy(desc(delivery_orders.id)).limit(50).offset(page * 50)
      .then(rows => rows.map(row => ({ ...this.summary(row.booking), order_number: row.order_number })));
  }
  static async setMethod(id: number, version: number, method: string, actor: Actor) {
    await this.order(id, actor);
    return db.transaction(async tx => {
      const [order] = await tx.select().from(orders).where(eq(orders.id, id)).for("update");
      if (!order || order.version !== version || !["PENDING", "PROCESSING", "SCHEDULING"].includes(order.status)) throw new WorkflowError("Order changed or is already scheduled. Refresh first.");
      await assertNoExternalClaim(tx, id); await assertNoInternalClaim(tx, id);
      await tx.update(orders).set({ delivery_method: method, version: order.version + 1, updated_at: new Date() }).where(eq(orders.id, id));
      await notifyLalamove(tx);
      return { message: "Delivery method saved." };
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
  static async pickupWarehouses(id: number, page: number, search: string, actor: Actor) {
    await this.order(id, actor);
    const scope = await staffWarehouse(actor);
    const where = and(eq(warehouses.is_archived, false), scope === undefined ? undefined : eq(warehouses.id, scope), search.trim() ? ilike(warehouses.name, `%${search.trim()}%`) : undefined);
    const [rows, totals] = await Promise.all([
      db.select({ id: warehouses.id, name: warehouses.name, street_address: warehouses.street_address, city: warehouses.city, state: warehouses.state, zip_code: warehouses.zip_code, phone_number: warehouses.phone_number, latitude: warehouses.latitude, longitude: warehouses.longitude }).from(warehouses).where(where).orderBy(desc(warehouses.id)).limit(10).offset(page * 10),
      db.select({ total: count() }).from(warehouses).where(where),
    ]);
    return { rows, total: totals[0]?.total ?? 0 };
  }
  static async setPickupWarehouse(id: number, version: number, warehouseId: number, actor: Actor) {
    await this.order(id, actor);
    const scope = await staffWarehouse(actor);
    if (scope !== undefined && warehouseId !== scope) throw new WorkflowError("Select your assigned warehouse for pickup.", 403);
    return db.transaction(async tx => {
      const [order] = await tx.select().from(orders).where(eq(orders.id, id)).for("update");
      if (!order || order.version !== version || !["PENDING", "PROCESSING", "SCHEDULING"].includes(order.status)) throw new WorkflowError("Order changed or is already scheduled. Refresh first.");
      await assertNoExternalClaim(tx, id); await assertNoInternalClaim(tx, id);
      const [warehouse] = await tx.select().from(warehouses).where(and(eq(warehouses.id, warehouseId), eq(warehouses.is_archived, false))).for("share");
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
    const pickup = warehouse && !warehouse.is_archived && coordinates(warehouse.latitude, warehouse.longitude);
    const dropoff = coordinates(order.shipping_latitude, order.shipping_longitude);
    if (!warehouse || !pickup || !dropoff) throw new WorkflowError("Verify warehouse and order destination coordinates first.");
    if (!warehouse.name?.trim() || !order.shipping_recipient?.trim() || !order.shipping_address?.trim()) throw new WorkflowError("Saved warehouse name and order recipient/address are required.");
    if (![warehouse.street_address, warehouse.city, warehouse.state, warehouse.zip_code].every(value => value?.trim())) throw new WorkflowError("Save a complete warehouse pickup address first.");
    return { pickup: { address: [warehouse.street_address, warehouse.city, warehouse.state, warehouse.zip_code].join(", "), lat: String(pickup.latitude), lng: String(pickup.longitude), name: warehouse.name, phone: internationalPhone(warehouse.phone_number) },
      dropoff: { address: order.shipping_address, lat: String(dropoff.latitude), lng: String(dropoff.longitude), name: order.shipping_recipient, phone: internationalPhone(order.shipping_phone) } };
  }
  static async createQuotation(input: { order_id: number; order_version: number; service_type: string; city: string }, actor: Actor) {
    requireLalamoveBooking();
    const order = await this.order(input.order_id, actor);
    if (order.version !== input.order_version) throw new WorkflowError("Order changed. Refresh first.");
    assertReady(order);
    await assertNoExternalClaim(db, order.id); await assertNoInternalClaim(db, order.id);
    const route = await this.route(order);
    const cities = await lalamoveRequest<{ data: { locode: string; services: { key: string }[] }[] }>("GET", "/cities");
    if (!cities.data.some(city => city.locode === input.city && city.services.some(service => service.key === input.service_type))) throw new WorkflowError("Select a supported city and vehicle service.", 400);
    const response = await lalamoveRequest<{ data: LalamoveQuotationResponse }>("POST", "/quotations", { data: {
      serviceType: input.service_type, language: "en_PH", stops: [route.pickup, route.dropoff].map(stop => ({ address: stop.address, coordinates: { lat: stop.lat, lng: stop.lng } })) } });
    const quote = response.data;
    if (typeof quote?.quotationId !== "string" || !quote.expiresAt || typeof quote.stops?.[0]?.stopId !== "string" || typeof quote.stops?.[1]?.stopId !== "string" || !Number.isFinite(Date.parse(quote.expiresAt))) throw new WorkflowError("Lalamove returned an invalid quotation.", 502);
    const config = lalamoveConfig();
    const [stored] = await db.insert(lalamove_quotations).values({ order_id: order.id, booked_by: Number(actor.sub), order_version: order.version,
      environment: config.environment, market: config.market, fingerprint: fingerprint(route), route, provider_quote: quote, expires_at: new Date(quote.expiresAt) }).returning();
    return { quotation_ref: stored.id, ...quote, route };
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
      assertReady(order); await assertNoExternalClaim(tx, order.id); await assertNoInternalClaim(tx, order.id);
      const [quote] = await tx.select().from(lalamove_quotations).where(eq(lalamove_quotations.id, input.quotation_ref));
      const config = lalamoveConfig();
      if (!quote || quote.order_id !== order.id || quote.booked_by !== Number(actor.sub) || quote.order_version !== order.version || quote.environment !== config.environment || quote.market !== config.market || quote.expires_at.getTime() <= Date.now()) throw new WorkflowError("Quotation is expired or belongs to another order/user. Request a fresh quote.");
      const route = await this.route(order);
      if (fingerprint(route) !== quote.fingerprint) throw new WorkflowError("Route or pickup contact changed. Request a new quotation.");
      const provider = quote.provider_quote as LalamoveQuotationResponse;
      const [booking] = await tx.insert(delivery_orders).values({ order_id: order.id, booked_by: Number(actor.sub), environment: config.environment, market: config.market,
        quotation_id: provider.quotationId, booking_state: "CREATING", active: true, idempotency_key: input.idempotency_key, request_fingerprint: requestFingerprint,
        service_type: provider.serviceType, route_snapshot: { route, stops: provider.stops }, recipient_name: route.dropoff.name, recipient_phone: route.dropoff.phone,
        pickup_address: route.pickup.address, dropoff_address: route.dropoff.address, status: "PENDING", delivery_fee: provider.priceBreakdown?.total, currency: provider.priceBreakdown?.currency }).returning();
      return { booking, submit: true };
    });
    if (!claimed.submit) return this.summary(claimed.booking);
    const booking = claimed.booking;
    const snapshot = booking.route_snapshot as { route: Route; stops: LalamoveQuotationResponse["stops"] };
    let placed: PlaceOrderResponse | undefined;
    try {
      placed = (await lalamoveRequest<{ data: PlaceOrderResponse }>("POST", "/orders", { data: { quotationId: booking.quotation_id,
        sender: { stopId: snapshot.stops[0].stopId, name: snapshot.route.pickup.name, phone: snapshot.route.pickup.phone },
        recipients: [{ stopId: snapshot.stops[1].stopId, name: snapshot.route.dropoff.name, phone: snapshot.route.dropoff.phone }], isPODEnabled: true,
        metadata: { source: "HYOps", orderId: String(input.order_id), bookingId: String(booking.id) } } })).data;
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
        await tx.update(delivery_orders).set({ booking_state: definitive ? "FAILED" : "UNKNOWN", active: !definitive,
          lalamove_order_id: current.lalamove_order_id ?? placed?.orderId ?? null,
          failure_message: definitive ? (error as Error).message : "Booking outcome needs reconciliation. Do not book again.", updated_at: now() }).where(eq(delivery_orders.id, booking.id));
      });
    }
    return this.summary(await this.booking(booking.id, actor));
  }
  static async apply(id: number, provider: PlaceOrderResponse, fetchedAt: Date) {
    return stockTransaction(async tx => {
      const [initial] = await tx.select().from(delivery_orders).where(eq(delivery_orders.id, id));
      if (!initial?.order_id) throw new WorkflowError("Unlinked external booking.");
      const [order] = await tx.select().from(orders).where(eq(orders.id, initial.order_id)).for("update");
      const [booking] = await tx.select().from(delivery_orders).where(eq(delivery_orders.id, id)).for("update");
      if (booking.last_synced_at && booking.last_synced_at > fetchedAt) return;
      if (provider.orderId !== booking.lalamove_order_id) throw new WorkflowError("Provider booking identity mismatch.");
      const status = provider.status;
      if (!booking.active && terminalStatuses.has(booking.status) && terminalStatuses.has(status)) {
        // A late callback for an ended attempt must not reclaim an order that may be rebooked.
        await tx.update(delivery_orders).set({ status, lalamove_response: provider, last_synced_at: fetchedAt, updated_at: now(),
          delivery_fee: provider.priceBreakdown?.total ?? booking.delivery_fee }).where(eq(delivery_orders.id, id));
        return;
      }
      const [owner] = await tx.select({ id: delivery_orders.id }).from(delivery_orders).where(and(eq(delivery_orders.order_id, order.id), eq(delivery_orders.active, true)));
      if (owner && owner.id !== id) throw new WorkflowError("Another booking owns this order. Review the provider event before applying it.");
      let pickedUp = booking.picked_up_at;
      let completed = booking.completed_at;
      let orderStatus = order.status;
      let active = booking.active;
      let state = "CONFIRMED";
      let failure: string | null = null;
      if (["PICKED_UP", "COMPLETED"].includes(status) && !pickedUp) {
        if (!order.stock_reserved || !["SCHEDULING", "SCHEDULED"].includes(order.status)) throw new WorkflowError("Pickup needs stock/custody reconciliation.");
        await changeOrderStock(tx, order.id, order.warehouse_id, "consume");
        pickedUp = new Date();
      }
      if (status === "COMPLETED") {
        orderStatus = "COMPLETED"; completed ??= new Date(); active = false;
        if (!booking.completed_at) await queueExternalDeliveryNotification(tx, id, order.id);
      }
      else if (pickedUp && !completed) { orderStatus = "IN_TRANSIT"; active = true; }
      else if (["ASSIGNING_DRIVER", "ON_GOING"].includes(status) && !completed) { orderStatus = "SCHEDULED"; active = true; }
      if (terminalStatuses.has(status) && !completed) {
        if (pickedUp || status === "CANCELED") { state = "REVIEW"; active = true; failure = pickedUp ? "Goods were picked up. Confirm custody/return before resolving." : "Confirm cancellation or provider replacement before releasing this order."; }
        else { active = false; orderStatus = "SCHEDULING"; }
      }
      if (!["ASSIGNING_DRIVER", "ON_GOING", "PICKED_UP", "COMPLETED", ...terminalStatuses].includes(status)) { state = "REVIEW"; active = true; failure = "Unrecognized provider status. Review required."; }
      if (booking.status !== status || (provider.priceBreakdown?.total && provider.priceBreakdown.total !== booking.delivery_fee)) {
        await tx.insert(lalamove_events).values({ environment: booking.environment, dedupe_key: `sync:${id}:${fetchedAt.toISOString()}:${status}`, event_type: "HYOPS_PROVIDER_SYNC", provider_order_id: provider.orderId,
          state: "PROCESSED", processed_at: new Date(), payload: { previousStatus: booking.status, status, previousCost: booking.delivery_fee, cost: provider.priceBreakdown?.total ?? booking.delivery_fee, currency: provider.priceBreakdown?.currency ?? booking.currency } }).onConflictDoNothing();
      }
      await tx.update(delivery_orders).set({ status, booking_state: state, active, picked_up_at: pickedUp, completed_at: completed,
        lalamove_response: provider, share_link: safeTrackingLink(provider.shareLink), driver_id: provider.driverId ?? null,
        ...(booking.driver_id !== (provider.driverId ?? null) ? { driver_details: null } : {}),
        delivery_fee: provider.priceBreakdown?.total ?? booking.delivery_fee, currency: provider.priceBreakdown?.currency ?? booking.currency,
        last_synced_at: fetchedAt, failure_message: failure, updated_at: now() }).where(eq(delivery_orders.id, id));
      if (order.status !== orderStatus) await tx.update(orders).set({ status: orderStatus, version: order.version + 1, updated_at: new Date() }).where(eq(orders.id, order.id));
      await notifyLalamove(tx);
    });
  }
  static async refresh(id: number, actor?: Actor) {
    const booking = actor ? await this.booking(id, actor) : (await db.select().from(delivery_orders).where(eq(delivery_orders.id, id)))[0];
    if (!booking) throw new WorkflowError("Booking not found.", 404);
    this.assertEnvironment(booking);
    if (!booking.lalamove_order_id) throw new WorkflowError("Provider identity is unknown. Reconcile in Partner Portal before retrying.");
    if (actor && booking.last_synced_at && Date.now() - booking.last_synced_at.getTime() < 5000) return this.summary(booking);
    const fetchedAt = new Date();
    const response = await lalamoveRequest<{ data: PlaceOrderResponse }>("GET", `/orders/${encodeURIComponent(booking.lalamove_order_id)}`);
    await this.apply(id, response.data, fetchedAt);
    if (response.data.driverId) {
      try {
        const driver = await lalamoveRequest<{ data: unknown }>("GET", `/orders/${encodeURIComponent(booking.lalamove_order_id)}/drivers/${encodeURIComponent(response.data.driverId)}`);
        await db.update(delivery_orders).set({ driver_details: driver.data }).where(and(eq(delivery_orders.id, id), eq(delivery_orders.driver_id, response.data.driverId)));
      } catch { /* Order refresh succeeds even if driver detail is temporarily unavailable. */ }
    }
    return this.summary((await db.select().from(delivery_orders).where(eq(delivery_orders.id, id)))[0]);
  }
  static async cancel(id: number, actor: Actor) {
    const booking = await this.booking(id, actor); this.assertEnvironment(booking);
    if (!booking.lalamove_order_id || !booking.active || booking.picked_up_at) throw new WorkflowError("This booking cannot be canceled here; review its current custody/status.");
    await lalamoveRequest("DELETE", `/orders/${encodeURIComponent(booking.lalamove_order_id)}`);
    await this.refresh(id); // Resolve only after provider confirms the cancellation.
    const current = await this.booking(id, actor);
    if (current.status === "CANCELED" && !current.picked_up_at) await this.resolve(id, "Confirmed staff cancellation through provider API.", actor, undefined, true);
    return this.summary(await this.booking(id, actor));
  }
  static async resolve(id: number, note: string, actor: Actor, providerId?: string, confirmedCancellation = false) {
    const booking = await this.booking(id, actor); this.assertEnvironment(booking);
    const orderId = booking.order_id;
    if (!orderId) throw new WorkflowError("Unlinked legacy booking.");
    if (actor.role !== "admin" && !confirmedCancellation) throw new WorkflowError("Administrator reconciliation required.", 403);
    if (providerId) {
      const fetchedAt = new Date();
      const { data } = await lalamoveRequest<{ data: PlaceOrderResponse }>("GET", `/orders/${encodeURIComponent(providerId)}`);
      if (data.metadata?.bookingId !== String(id) || data.metadata?.orderId !== String(booking.order_id)) throw new WorkflowError("Provider metadata does not identify this booking. Contact support.");
      await db.transaction(async tx => {
        const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for("update");
        if (!order) throw new WorkflowError("Order not found.");
        await tx.update(delivery_orders).set({ lalamove_order_id: providerId, resolution_note: note }).where(eq(delivery_orders.id, id));
        await tx.insert(lalamove_provider_ids).values({ identity: identity(providerId), booking_id: id }).onConflictDoNothing();
      });
      await this.apply(id, data, fetchedAt); return { message: "Provider booking linked and synchronized." };
    }
    await db.transaction(async tx => {
      const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for("update");
      const [current] = await tx.select().from(delivery_orders).where(eq(delivery_orders.id, id)).for("update");
      if (current.picked_up_at) throw new WorkflowError("Post-pickup custody requires a return investigation; this action cannot restore stock.");
      if (!current.active || !["UNKNOWN", "REVIEW"].includes(current.booking_state)) throw new WorkflowError("Only unresolved attempts can be released.");
      if (current.lalamove_order_id && !terminalStatuses.has(current.status)) throw new WorkflowError("Known booking is still active. Refresh/cancel it first.");
      await tx.update(delivery_orders).set({ active: false, booking_state: "RESOLVED", resolution_note: note, updated_at: now() }).where(eq(delivery_orders.id, id));
      if (order.status === "SCHEDULED") await tx.update(orders).set({ status: "SCHEDULING", version: order.version + 1, updated_at: new Date() }).where(eq(orders.id, order.id));
      await notifyLalamove(tx);
    });
    return { message: "Attempt resolved. The order may be booked again explicitly." };
  }
}
