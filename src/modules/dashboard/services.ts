import { findCashMovements } from "../analysis-reports/repositories/payments.repository";
import { DEFAULT_FILTERS } from "../analysis-reports/reports.contract";
import { getDeliveryCalendar } from "../deliveries/calendar";
import { DAY, dayStart, manilaDay } from "../../utils/time";
import { sumMoney } from "../analysis-reports/domain/metrics";
import { db } from "@/db/index";
import { deliveries, deliveries_stops } from "@/db/schema/deliveries";
import { inventory } from "@/db/schema/inventory";
import { order_items, orders } from "@/db/schema/order";
import { payments } from "@/db/schema/payment";
import { product_variants, products } from "@/db/schema/products";
import { customer_addresses, customers, users } from "@/db/schema/users";
import { and, asc, desc, eq, gte, lt, ne, or, sql } from "drizzle-orm";

export abstract class DashboardService {
  static async getDeliveryCalendar(warehouseId?: number) {
    return getDeliveryCalendar(warehouseId);
  }
  static async getExceptions() {
    const [result] = await db.select({
      overdueDeliveries: sql<number>`count(*) filter (where ${deliveries.status} = 'scheduled' and (${deliveries.scheduled_date} + ${deliveries.departure_time}) at time zone 'Asia/Manila' < now())`.mapWith(Number),
    }).from(deliveries);
    const [pending] = await db.select({ count: sql<number>`count(*)`.mapWith(Number) }).from(orders).where(eq(orders.status, "PENDING"));
    return { ...result, pendingOrders: pending.count };
  }

  static async getUpcomingDeliveries() {
    const now = new Date();
    const today = `${now.getUTCFullYear()}-${String(
      now.getUTCMonth() + 1,
    ).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}`;

    const results = await db
      .select({
        id: deliveries.id,
        date: deliveries.scheduled_date,
        time: deliveries.departure_time,
        driver: users.name,
        customer: sql<string>`case when count(distinct ${orders.customer_id}) > 1 then 'Multiple customers' else coalesce(min(${customers.company_name}), 'Customer unavailable') end`,
        destination: sql<string>`case when count(distinct ${orders.shipping_address}) > 1 then 'Multiple destinations' else coalesce(min(${orders.shipping_address}), 'Destination unavailable') end`,
      })
      .from(deliveries)
      .innerJoin(users, eq(deliveries.driver_id, users.id))
      .leftJoin(
        deliveries_stops,
        eq(deliveries.id, deliveries_stops.delivery_id),
      )
      .leftJoin(orders, eq(deliveries_stops.order_id, orders.id))
      .leftJoin(customers, eq(orders.customer_id, customers.id))
      .where(
        and(
          eq(deliveries.status, "scheduled"),
          sql`(${deliveries.scheduled_date} + ${deliveries.departure_time}) at time zone 'Asia/Manila' >= now()`,
        ),
      )
      .groupBy(
        deliveries.id,
        deliveries.scheduled_date,
        deliveries.departure_time,
        users.name,
      )
      .orderBy(asc(deliveries.scheduled_date), asc(deliveries.departure_time))
      .limit(3);

    return results.map((result) => ({
      run: `RUN-${String(result.id).padStart(4, "0")}`,
      date: result.date,
      time: result.time,
      customer: result.customer,
      destination: result.destination,
      driver: result.driver,
    }));
  }

  static async getActiveDeliveries() {
    const results = await db
      .select({
        id: deliveries.id,
        driver: users.name,
        status: deliveries.status,
        customer: sql<string>`case when count(distinct ${orders.customer_id}) > 1 then 'Multiple customers' else coalesce(min(${customers.company_name}), 'Customer unavailable') end`,
        destination: sql<string>`case when count(distinct ${orders.shipping_address}) > 1 then 'Multiple destinations' else coalesce(min(${orders.shipping_address}), 'Destination unavailable') end`,
        delivered: sql<number>`count(*) filter (where ${deliveries_stops.status} = 'delivered')`,
        stops: sql<number>`count(${deliveries_stops.order_id})`,
      })
      .from(deliveries)
      .innerJoin(users, eq(deliveries.driver_id, users.id))
      .leftJoin(
        deliveries_stops,
        eq(deliveries.id, deliveries_stops.delivery_id),
      )
      .leftJoin(orders, eq(deliveries_stops.order_id, orders.id))
      .leftJoin(customers, eq(orders.customer_id, customers.id))
      .where(
        or(
          eq(deliveries.status, "scheduled"),
          eq(deliveries.status, "in_transit"),
          eq(deliveries.status, "returning"),
        ),
      )
      .groupBy(deliveries.id, users.name, deliveries.status)
      .orderBy(asc(deliveries.scheduled_date), asc(deliveries.departure_time))
      .limit(5);

    return results.map((result) => ({
      run: `RUN-${String(result.id).padStart(4, "0")}`,
      customer: result.customer,
      destination: result.destination,
      driver: result.driver,
      progress: `${Number(result.delivered)} / ${Number(result.stops)} stops`,
      status: result.status.toUpperCase(),
    }));
  }

  static async getTopSellingProducts() {
    const results = await db
      .select({
        name: product_variants.name,
        sku: product_variants.sku,
        sold: sql<number>`coalesce(sum(${order_items.quantity}), 0)`,
        revenue: sql<string | null>`case
          when bool_and(${order_items.unit_price_snapshot} is not null)
          then sum(${order_items.quantity} * ${order_items.unit_price_snapshot})::text
          else null
        end`,
      })
      .from(order_items)
      .innerJoin(orders, eq(order_items.order_id, orders.id))
      .innerJoin(inventory, eq(order_items.inventory_id, inventory.id))
      .innerJoin(
        product_variants,
        eq(inventory.product_variant_id, product_variants.id),
      )
      .where(ne(orders.status, "CANCELLED"))
      .groupBy(product_variants.id, product_variants.name, product_variants.sku)
      .orderBy(desc(sql`sum(${order_items.quantity})`))
      .limit(5);

    const maxSold = Number(results[0]?.sold ?? 0);

    return results.map((result) => ({
      name: result.name,
      sku: result.sku,
      sold: Number(result.sold),
      revenue: result.revenue === null ? null : Number(result.revenue),
      percent:
        maxSold > 0 ? Math.round((Number(result.sold) / maxSold) * 100) : 0,
    }));
  }

  static async getTopCustomers() {
    const results = await db
      .select({
        name: customers.company_name,
        location: sql<string>`coalesce((
          select concat_ws(
            ', ',
            ${customer_addresses.address_line},
            ${customer_addresses.barangay},
            ${customer_addresses.city_municipality},
            ${customer_addresses.province},
            ${customer_addresses.postal_code}
          )
          from ${customer_addresses}
          where ${customer_addresses.customer_id} = ${customers.id}
          order by ${customer_addresses.id}
          limit 1
        ), 'No address on file')`,
        orders: sql<number>`count(distinct ${orders.id})`,
        amount: sql<string | null>`case
          when count(${order_items.id}) = 0 or bool_and(${order_items.unit_price_snapshot} is not null)
          then coalesce(sum(${order_items.quantity} * ${order_items.unit_price_snapshot}), 0)::text
          else null
        end`,
      })
      .from(orders)
      .innerJoin(customers, eq(orders.customer_id, customers.id))
      .leftJoin(order_items, eq(order_items.order_id, orders.id))
      .where(ne(orders.status, "CANCELLED"))
      .groupBy(customers.id, customers.company_name)
      .orderBy(desc(sql`count(distinct ${orders.id})`))
      .limit(5);

    const maxOrders = Number(results[0]?.orders ?? 0);

    return results.map((result) => ({
      name: result.name,
      location: result.location,
      orders: Number(result.orders),
      amount: result.amount === null ? null : Number(result.amount),
      percent:
        maxOrders > 0
          ? Math.round((Number(result.orders) / maxOrders) * 100)
          : 0,
    }));
  }

  static async getSalesByDay() {
    const end = dayStart(manilaDay(Date.now())) + DAY; const start = end - 7 * DAY;
    const movements = await findCashMovements(DEFAULT_FILTERS, { start, end });
    return Array.from({ length: 7 }, (_, i) => {
      const instant = start + i * DAY; const key = manilaDay(instant);
      return { day: new Date(instant).toLocaleDateString("en-US", { weekday: "short", timeZone: "Asia/Manila" }), sales: sumMoney(movements.filter((p) => manilaDay(p.at) === key), (p) => p.amount) };
    });
  }
  static async getRevenueByMonth() {
    const today = manilaDay(Date.now()); const year = Number(today.slice(0, 4)), month = Number(today.slice(5, 7)) - 1;
    const keys = Array.from({ length: 6 }, (_, i) => new Date(Date.UTC(year, month - 5 + i, 1)).toISOString().slice(0, 7));
    const start = dayStart(`${keys[0]}-01`); const end = dayStart(new Date(Date.UTC(year, month + 1, 1)).toISOString().slice(0, 10));
    const movements = await findCashMovements(DEFAULT_FILTERS, { start, end });
    return keys.map((key) => ({ month: new Date(`${key}-01T00:00:00+08:00`).toLocaleDateString("en-US", { month: "short", timeZone: "Asia/Manila" }), revenue: sumMoney(movements.filter((p) => manilaDay(p.at).startsWith(key)), (p) => p.amount) }));
  }
}
