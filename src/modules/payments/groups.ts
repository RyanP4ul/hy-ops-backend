import { db } from "../../db";
import { payment_group_allocations, payment_groups, payments } from "../../db/schema";
import { eq } from "drizzle-orm";

export async function getOrderCombinedPayment(orderId: number, executor: Pick<typeof db, "select"> = db) {
  const [row] = await executor.select({
    payment_number: payment_groups.payment_number,
    amount: payment_groups.amount,
    allocated_amount: payment_group_allocations.amount,
    reference_number: payment_groups.reference_number,
  }).from(payments)
    .innerJoin(payment_group_allocations, eq(payment_group_allocations.payment_id, payments.id))
    .innerJoin(payment_groups, eq(payment_groups.id, payment_group_allocations.group_id))
    .where(eq(payments.order_id, orderId)).limit(1);
  return row ? { ...row, amount: Number(row.amount), allocated_amount: Number(row.allocated_amount) } : null;
}
