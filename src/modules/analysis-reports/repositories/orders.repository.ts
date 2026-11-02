import { and, desc, eq, gte, inArray, lt, sql, type SQL } from "drizzle-orm";
import {
  customers,
  inventory,
  order_items,
  orders,
  payments,
  product_variants,
  products,
  users,
  warehouses,
} from "@/db/schema";
import type { Filters, OrderStatus, PaymentMethod } from "../reports.contract";
import type { OrderView, Range } from "../domain/types";
import {
  buildOrderViews,
  RECEIVED_PAYMENT_STATUSES,
} from "../domain/order-rules";
import { findLatestDeliveryByOrder } from "./deliveries.repository";
import { db } from "@/db/index";

/**
 * SQL-level order filters: date (created_at), customer, warehouse, status, product.
 * Filters on derived values (payment status, arrangement fallback, delivery) run later in domain/filters.ts.
 */
export function orderWhere(
  f: Filters,
  opts: { range?: Range; extra?: SQL } = {},
): SQL | undefined {
  const c: (SQL | undefined)[] = [];
  if (opts.range)
    c.push(
      gte(orders.created_at, new Date(opts.range.start)),
      lt(orders.created_at, new Date(opts.range.end)),
    );
  if (f.customers.length)
    c.push(inArray(orders.customer_id, f.customers.map(Number)));
  if (f.warehouses.length)
    c.push(inArray(orders.warehouse_id, f.warehouses.map(Number)));
  if (f.orderStatuses.length)
    c.push(inArray(orders.status, f.orderStatuses as OrderStatus[]));
  if (f.paymentMethods.length)
    c.push(inArray(orders.id, db.select({ id: payments.order_id }).from(payments).where(inArray(payments.payment_method, f.paymentMethods as PaymentMethod[]))));
  if (f.products.length) {
    c.push(
      inArray(
        orders.id,
        db
          .select({ id: order_items.order_id })
          .from(order_items)
          .innerJoin(inventory, eq(order_items.inventory_id, inventory.id))
          .where(inArray(inventory.product_id, f.products.map(Number))),
      ),
    );
  }
  c.push(opts.extra);
  return and(...c);
}

/**
 * Loads orders matching `where` together with their items, amount received and latest delivery (5 queries, run in parallel),
 * then derives total / balance / due date / payment status. Newest first.
 */
export async function findOrderViews(
  where: SQL | undefined,
  now: number,
): Promise<OrderView[]> {
  const ids = () => db.select({ id: orders.id }).from(orders).where(where);

  const [rows, items, paid, deliveryByOrder] = await Promise.all([
    db
      .select({
        id: orders.id,
        number: orders.order_number,
        createdAt: orders.created_at,
        customerId: customers.id,
        company: customers.company_name,
        contact: users.name,
        warehouseId: orders.warehouse_id,
        warehouse: warehouses.name,
        status: orders.status,
        arrangement: orders.payment_arrangement,
      })
      .from(orders)
      .innerJoin(customers, eq(orders.customer_id, customers.id))
      .innerJoin(users, eq(customers.user_id, users.id))
      .leftJoin(warehouses, eq(orders.warehouse_id, warehouses.id))
      .where(where)
      .orderBy(desc(orders.created_at), desc(orders.id)),
    db
      .select({
        orderId: order_items.order_id,
        inventoryId: inventory.id,
        productId: inventory.product_id,
        product: products.name,
        variantId: product_variants.id,
        variant: product_variants.name,
        sku: product_variants.sku,
        qty: order_items.quantity,
        price: order_items.unit_price_snapshot,
      })
      .from(order_items)
      .innerJoin(inventory, eq(order_items.inventory_id, inventory.id))
      .innerJoin(products, eq(inventory.product_id, products.id))
      .innerJoin(
        product_variants,
        eq(inventory.product_variant_id, product_variants.id),
      )
      .where(inArray(order_items.order_id, ids()))
      .orderBy(order_items.id),
    db
      .select({
        orderId: payments.order_id,
        paid: sql<number>`sum(${payments.amount})`.mapWith(Number),
      })
      .from(payments)
      .where(
        and(
          inArray(payments.order_id, ids()),
          inArray(payments.payment_status, RECEIVED_PAYMENT_STATUSES),
        ),
      )
      .groupBy(payments.order_id),
    findLatestDeliveryByOrder(ids),
  ]);

  return buildOrderViews(
    rows,
    items,
    new Map(paid.map((p) => [p.orderId, p.paid])),
    deliveryByOrder,
    now,
  );
}
