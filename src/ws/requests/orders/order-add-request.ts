import z from "zod";
import { RequestBase, Request } from "../request-base";
import { TOPIC } from "../../topic";
import { OrderInsert } from "@/db/schema/order";

@Request("ORDER_ADDED")
export class AddOrderHandler extends RequestBase<typeof AddOrderHandler.schema> {
  static override schema = z.tuple([z.string()]);
  override skipValidation = false;

  override async execute(): Promise<void> {
    const [order_data] = this.data;

    const data_parsed = JSON.parse(order_data) as {
      id: number;
      customer_id: number;
      delivery_type: "LALAMOVE" | "PICKUP" | "INTERNAL";
      notes: string | null;
    };

    if (!data_parsed) {
      throw new Error("Invalid order data provided.");
    }

    this.publishBySubscribed(
      {
        type: "ORDER_ADDED",
        payload: {
          ...data_parsed,
        },
      },
      TOPIC.ORDERS,
      [this.session.ws.id],
    );
  }
}
