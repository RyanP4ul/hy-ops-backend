import { and, desc, eq, gte, inArray, lt, notExists, sql } from "drizzle-orm";
import { orders, payments, payment_receipts, payment_refunds } from "@/db/schema";
import type { Filters, PaymentMethod } from "../reports.contract";
import type { Range } from "../domain/types";
import { orderWhere } from "./orders.repository";
import { db } from "@/db/index";

export interface PaymentRow { id: number; number: string; method: PaymentMethod; amount: number; at: number; orderId: number; kind: "receipt" | "legacy_aggregate" | "refund" }
/** Positive receipts and negative refunds use their own event dates, regardless of current paid status. */
export async function findCashMovements(f: Filters, range: Range): Promise<PaymentRow[]> {
  const scope = and(f.paymentMethods.length ? inArray(payments.payment_method, f.paymentMethods as PaymentMethod[]) : undefined,
    inArray(payments.order_id, db.select({ id: orders.id }).from(orders).where(orderWhere(f))));
  const [receipts, refunds, legacy] = await Promise.all([
    db.select({ id: payment_receipts.id, number: payments.payment_number, method: payments.payment_method, amount: payment_receipts.amount,
      at: payment_receipts.received_at, orderId: payments.order_id, kind: payment_receipts.kind }).from(payment_receipts).innerJoin(payments, eq(payments.id, payment_receipts.payment_id))
      .where(and(scope, gte(payment_receipts.received_at, new Date(range.start)), lt(payment_receipts.received_at, new Date(range.end)))),
    db.select({ id: payment_refunds.id, number: payments.payment_number, method: payments.payment_method, amount: payment_refunds.amount,
      at: payment_refunds.created_at, orderId: payments.order_id }).from(payment_refunds).innerJoin(payments, eq(payments.id, payment_refunds.payment_id))
      .where(and(scope, gte(payment_refunds.created_at, new Date(range.start)), lt(payment_refunds.created_at, new Date(range.end)))),
    db.select({ id: payments.id, number: payments.payment_number, method: payments.payment_method,
      amount: sql<string>`${payments.amount} + ${payments.refunded_amount}`, at: payments.received_at, orderId: payments.order_id }).from(payments)
      .where(and(scope, gte(payments.received_at, new Date(range.start)), lt(payments.received_at, new Date(range.end)),
        notExists(db.select({ id: payment_receipts.id }).from(payment_receipts).where(eq(payment_receipts.payment_id, payments.id))))),
  ]);
  return [...receipts.map((r) => ({ ...r, amount: Number(r.amount), at: r.at.getTime(), kind: r.kind as PaymentRow["kind"] })),
    ...refunds.map((r) => ({ ...r, amount: -Number(r.amount), at: r.at.getTime(), kind: "refund" as const })),
    ...legacy.flatMap((r) => r.at && Number(r.amount) > 0 ? [{ ...r, amount: Number(r.amount), at: r.at.getTime(), kind: "legacy_aggregate" as const }] : [])]
    .sort((a, b) => b.at - a.at || b.id - a.id);
}
