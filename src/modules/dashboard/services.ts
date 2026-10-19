import { db } from "@/db/index";
import {
  deliveries,
  deliveries_orders,
} from "@/db/schema/deliveries";
import { inventory } from "@/db/schema/inventory";
import { order_items, orders } from "@/db/schema/order";
import { payments } from "@/db/schema/payment";
import { product_variants, products } from "@/db/schema/products";
import { customers, users } from "@/db/schema/users";
import { and, asc, desc, eq, gte, lt, ne, or, sql } from "drizzle-orm";

export abstract class DashboardService {
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
        customer: sql<string>`coalesce(min(${customers.company_name}), 'Multiple customers')`,
        destination: sql<string>`coalesce(min(${customers.address}), 'Multiple destinations')`,
      })
      .from(deliveries)
      .innerJoin(users, eq(deliveries.driver_id, users.id))
      .leftJoin(
        deliveries_orders,
        eq(deliveries.id, deliveries_orders.delivery_id),
      )
      .leftJoin(orders, eq(deliveries_orders.order_id, orders.id))
      .leftJoin(customers, eq(orders.customer_id, customers.id))
      .where(
        and(
          eq(deliveries.status, "scheduled"),
          gte(deliveries.scheduled_date, today),
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
        customer: sql<string>`coalesce(min(${customers.company_name}), 'Multiple customers')`,
        destination: sql<string>`coalesce(min(${customers.address}), 'Multiple destinations')`,
        delivered: sql<number>`count(*) filter (where ${deliveries_orders.status} = 'delivered')`,
        stops: sql<number>`count(${deliveries_orders.order_id})`,
      })
      .from(deliveries)
      .innerJoin(users, eq(deliveries.driver_id, users.id))
      .leftJoin(
        deliveries_orders,
        eq(deliveries.id, deliveries_orders.delivery_id),
      )
      .leftJoin(orders, eq(deliveries_orders.order_id, orders.id))
      .leftJoin(customers, eq(orders.customer_id, customers.id))
      .where(
        or(eq(deliveries.status, "scheduled"), eq(deliveries.status, "in_transit")),
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
        revenue: sql<string>`coalesce(sum(${order_items.quantity} * ${product_variants.price}), 0)`,
      })
      .from(order_items)
      .innerJoin(orders, eq(order_items.order_id, orders.id))
      .innerJoin(
        inventory,
        eq(order_items.inventory_id, inventory.id),
      )
      .innerJoin(
        product_variants,
        eq(inventory.product_variant_id, product_variants.id),
      )
      .innerJoin(products, eq(product_variants.product_id, products.id))
      .where(ne(orders.status, "CANCELLED"))
      .groupBy(product_variants.id, product_variants.name, product_variants.sku)
      .orderBy(desc(sql`sum(${order_items.quantity})`))
      .limit(5);

    const maxSold = Number(results[0]?.sold ?? 0);

    return results.map((result) => ({
      name: result.name,
      sku: result.sku,
      sold: Number(result.sold),
      revenue: Number(result.revenue),
      percent: maxSold > 0 ? Math.round((Number(result.sold) / maxSold) * 100) : 0,
    }));
  }

  static async getTopCustomers() {
    const results = await db
      .select({
        name: customers.company_name,
        location: customers.address,
        orders: sql<number>`count(distinct ${orders.id})`,
        amount: sql<string>`coalesce(sum(${order_items.quantity} * ${product_variants.price}), 0)`,
      })
      .from(orders)
      .innerJoin(customers, eq(orders.customer_id, customers.id))
      .leftJoin(order_items, eq(order_items.order_id, orders.id))
      .leftJoin(inventory, eq(order_items.inventory_id, inventory.id))
      .leftJoin(
        product_variants,
        eq(inventory.product_variant_id, product_variants.id),
      )
      .where(ne(orders.status, "CANCELLED"))
      .groupBy(customers.id, customers.company_name, customers.address)
      .orderBy(desc(sql`count(distinct ${orders.id})`))
      .limit(5);

    const maxOrders = Number(results[0]?.orders ?? 0);

    return results.map((result) => ({
      name: result.name,
      location: result.location,
      orders: Number(result.orders),
      amount: Number(result.amount),
      percent:
        maxOrders > 0 ? Math.round((Number(result.orders) / maxOrders) * 100) : 0,
    }));
  }

  static async getSalesByDay() {
    const now = new Date();
    const today = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const startOfRange = new Date(
      Date.UTC(
        today.getUTCFullYear(),
        today.getUTCMonth(),
        today.getUTCDate() - 6,
      ),
    );
    const startOfNextDay = new Date(
      Date.UTC(
        today.getUTCFullYear(),
        today.getUTCMonth(),
        today.getUTCDate() + 1,
      ),
    );

    const results = await db
      .select({
        day: sql<string>`to_char(date_trunc('day', ${payments.received_at} AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`,
        sales: sql<string>`coalesce(sum(${payments.amount}), 0)`,
      })
      .from(payments)
      .where(
        and(
          gte(payments.received_at, startOfRange),
          lt(payments.received_at, startOfNextDay),
          or(
            eq(payments.payment_status, "PAID"),
            eq(payments.payment_status, "PARTIALLY_PAID"),
          ),
        ),
      )
      .groupBy(
        sql`date_trunc('day', ${payments.received_at} AT TIME ZONE 'UTC')`,
      )
      .orderBy(
        sql`date_trunc('day', ${payments.received_at} AT TIME ZONE 'UTC')`,
      );

    const salesByDay = new Map(
      results.map((result) => [result.day, Number(result.sales)]),
    );

    return Array.from({ length: 7 }, (_, index) => {
      const day = new Date(
        Date.UTC(
          startOfRange.getUTCFullYear(),
          startOfRange.getUTCMonth(),
          startOfRange.getUTCDate() + index,
        ),
      );
      const dayKey = day.toISOString().slice(0, 10);

      return {
        day: day.toLocaleString("en-US", {
          weekday: "short",
          timeZone: "UTC",
        }),
        sales: salesByDay.get(dayKey) ?? 0,
      };
    });
  }

  static async getRevenueByMonth() {
    const now = new Date();
    const currentMonth = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    );
    const startOfRange = new Date(
      Date.UTC(
        currentMonth.getUTCFullYear(),
        currentMonth.getUTCMonth() - 5,
        1,
      ),
    );
    const startOfNextMonth = new Date(
      Date.UTC(
        currentMonth.getUTCFullYear(),
        currentMonth.getUTCMonth() + 1,
        1,
      ),
    );

    const results = await db
      .select({
        month: sql<string>`to_char(date_trunc('month', ${payments.received_at} AT TIME ZONE 'UTC'), 'YYYY-MM')`,
        revenue: sql<string>`coalesce(sum(${payments.amount}), 0)`,
      })
      .from(payments)
      .where(
        and(
          gte(payments.received_at, startOfRange),
          lt(payments.received_at, startOfNextMonth),
          or(
            eq(payments.payment_status, "PAID"),
            eq(payments.payment_status, "PARTIALLY_PAID"),
          ),
        ),
      )
      .groupBy(
        sql`date_trunc('month', ${payments.received_at} AT TIME ZONE 'UTC')`,
      )
      .orderBy(
        sql`date_trunc('month', ${payments.received_at} AT TIME ZONE 'UTC')`,
      );

    const revenueByMonth = new Map(
      results.map((result) => [result.month, Number(result.revenue)]),
    );

    return Array.from({ length: 6 }, (_, index) => {
      const month = new Date(
        Date.UTC(
          startOfRange.getUTCFullYear(),
          startOfRange.getUTCMonth() + index,
          1,
        ),
      );
      const monthKey = `${month.getUTCFullYear()}-${String(
        month.getUTCMonth() + 1,
      ).padStart(2, "0")}`;

      return {
        month: month.toLocaleString("en-US", {
          month: "short",
          timeZone: "UTC",
        }),
        revenue: revenueByMonth.get(monthKey) ?? 0,
      };
    });
  }
}
