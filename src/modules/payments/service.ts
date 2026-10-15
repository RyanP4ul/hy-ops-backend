import { db } from "@/db/index";
import { PaymentInsert, payments } from "@/db/schema/payment";

export abstract class PaymentService {
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
}
