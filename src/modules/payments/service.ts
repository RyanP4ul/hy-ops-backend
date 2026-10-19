import { db } from "@/db/index";
import {
  customers,
  inventory,
  order_items,
  product_variants,
  users,
} from "@/db/schema";
import { PaymentInsert, payments } from "@/db/schema/payment";
import { and, asc, count, desc, eq, ilike, ne, or } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { PaymentUpdate } from "./model";

export abstract class PaymentService {
  static async getPayments(
    page = 0,
    limit = 10,
    search = "",
    sortBy = "id:desc",
  ) {
    const [sortField, sortOrder] = sortBy.split(":");
    const paymentTotals = alias(payments, "payment_totals");
    const orderTotals = db
      .select({
        orderId: order_items.order_id,
        total: sql<string>`
        coalesce(
          sum(${order_items.quantity} * ${product_variants.price}),
          0
        )
      `.as("order_total"),
      })
      .from(order_items)
      .leftJoin(inventory, eq(order_items.inventory_id, inventory.id))
      .leftJoin(
        product_variants,
        eq(inventory.product_variant_id, product_variants.id),
      )
      .groupBy(order_items.order_id)
      .as("order_totals");

    const paidTotals = db
      .select({
        orderId: paymentTotals.order_id,
        total: sql<string>`coalesce(sum(${paymentTotals.amount}), 0)`.as(
          "total",
        ),
      })
      .from(paymentTotals)
      .groupBy(paymentTotals.order_id)
      .as("paid_totals");
    const searchQuery = search
      ? or(
          ilike(payments.payment_number, `%${search}%`),
          ilike(payments.reference_number, `%${search}%`),
          ilike(users.name, `%${search}%`),
          ilike(payments.payment_status, `%${search}%`),
        )
      : undefined;

    const [totalResult] = await db
      .select({ count: count() })
      .from(payments)
      .leftJoin(customers, eq(payments.customer_id, customers.id))
      .leftJoin(users, eq(customers.user_id, users.id))
      .where(and(searchQuery));

    const rows = await db
      .select({
        id: payments.id,
        payment_number: payments.payment_number,
        order_id: payments.order_id,
        customer_id: payments.customer_id,
        customer_name: users.name,
        payment_method: payments.payment_method,
        payment_status: payments.payment_status,
        amount: payments.amount,
        remaining_amount: sql<string>`greatest(
          coalesce(${orderTotals.total}, 0) - coalesce(${paidTotals.total}, 0),
          0
        )`,
        reference_number: payments.reference_number,
        received_at: payments.received_at,
        version: payments.version,
      })
      .from(payments)
      .leftJoin(customers, eq(payments.customer_id, customers.id))
      .leftJoin(users, eq(customers.user_id, users.id))
      .leftJoin(orderTotals, eq(payments.order_id, orderTotals.orderId))
      .leftJoin(paidTotals, eq(payments.order_id, paidTotals.orderId))
      .where(and(searchQuery, ne(payments.payment_status, "PAID")))
      .orderBy(this.sortByField(sortField, sortOrder))
      .limit(limit)
      .offset(Math.max(page * limit, 0));

    return {
      rows,
      total: Number(totalResult?.count ?? 0),
    };
  }

  private static sortByField(
    field: string | undefined,
    order: string | undefined,
  ) {
    const column = {
      id: payments.id,
      payment_number: payments.payment_number,
      amount: payments.amount,
      received_at: payments.received_at,
    }[field ?? "id"];

    return (order === "asc" ? asc : desc)(column ?? payments.id);
  }

  static async createPayment(data: PaymentInsert) {
    return await db.transaction(async (tx) => {
      const [new_payment] = await tx.insert(payments).values(data).returning({
        id: payments.id,
        payment_number: payments.payment_number,
      });

      if (!new_payment) {
        throw new Error("Failed to create payment");
      }

      return new_payment;
    });
  }

  static async getOrderTotal(orderId: number) {
    const [total_order_price] = await db
      .select({
        total: sql<string>`coalesce(sum(${order_items.quantity} * ${product_variants.price}),0)`,
      })
      .from(order_items)
      .leftJoin(inventory, eq(order_items.inventory_id, inventory.id))
      .leftJoin(
        product_variants,
        eq(inventory.product_variant_id, product_variants.id),
      )
      .where(eq(order_items.order_id, orderId));

    return total_order_price?.total || "0";
  }

  static async updatePayment(data: PaymentUpdate) {
    return await db.transaction(async (tx) => {
      const [payment] = await tx
        .select()
        .from(payments)
        .where(
          and(
            eq(payments.payment_number, data.payment_number),
            eq(payments.version, data.version),
          ),
        );

      if (!payment) {
        throw new Error(
          `Payment with number ${data.payment_number} and version ${data.version} not found`,
        );
      }

      const total_cost = await this.getOrderTotal(payment.order_id);
      const total_paid = Number(Number(payment.amount) + data.payment_amount);
      const total_remaining = Number(Number(total_cost) - total_paid);
      const is_paid = total_remaining <= 0;

      const [updated_payment] = await tx
        .update(payments)
        .set({
          amount: String(Math.min(total_paid, Number(total_cost))),
          payment_status: is_paid ? "PAID" : "PARTIALLY_PAID",
          received_at: new Date(),
          version: payment.version + 1,
        })
        .where(
          and(
            eq(payments.payment_number, data.payment_number),
            eq(payments.version, data.version),
          ),
        )
        .returning({
          payment_number: payments.payment_number,
        });

      return {
        message: `Payment ${updated_payment.payment_number} updated successfully`,
      };
    });
  }
}
