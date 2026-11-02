import z from "zod";
import { RequestBase, Request } from "../request-base";
import { TOPIC } from "../../topic";

@Request("PAYMENT_UPDATED")
export class PaymentUpdatedHandler extends RequestBase<
  typeof PaymentUpdatedHandler.schema
> {
  static override schema = z.tuple([z.string()]);

  override async execute(): Promise<void> {
    const [paymentData] = this.data;
    const payment = JSON.parse(paymentData);

    if (!payment?.id || !payment.payment_number) {
      throw new Error("Invalid payment data provided.");
    }

    this.publishBySubscribed(
      {
        type: "PAYMENT_UPDATED",
        payload: payment,
      },
      TOPIC.PAYMENTS,
      [this.session.ws.id],
    );
  }
}
