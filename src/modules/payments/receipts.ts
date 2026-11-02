import { eq } from "drizzle-orm";
import type { db } from "../../db";
import { payment_receipts, type PaymentSelect } from "../../db/schema";
import { moneyToMinorUnits, minorUnitsToMoney } from "../../utils/money";
import { WorkflowError } from "../../utils/workflow-error";
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Caller holds the payment lock. Preserve an explicitly labeled legacy aggregate. */
export async function preserveReceiptBaseline(tx: Transaction, payment: PaymentSelect) {
  const [existing] = await tx.select({ id: payment_receipts.id }).from(payment_receipts).where(eq(payment_receipts.payment_id, payment.id)).limit(1);
  const gross = moneyToMinorUnits(payment.amount) + moneyToMinorUnits(payment.refunded_amount);
  if (existing || gross === 0n) return;
  if (!payment.received_at) throw new WorkflowError("Historical receipt date is missing. Verify it before adjusting this payment.");
  await tx.insert(payment_receipts).values({ payment_id: payment.id, amount: minorUnitsToMoney(gross), received_at: payment.received_at, kind: "legacy_aggregate" });
}
