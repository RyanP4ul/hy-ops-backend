import z from "zod";
import { RequestBase, Request } from "../request-base";
import { TOPIC } from "../../topic";

@Request("ORDER_UPDATED")
export class UpdateOrderHandler extends RequestBase<typeof UpdateOrderHandler.schema> {
  static override schema = z.tuple([z.string()]);
  override skipValidation = false;

  override async execute(): Promise<void> {
    const [order_data] = this.data;

    const data_parsed = JSON.parse(order_data) as {
      id: number;
      customer_id: number;
      delivery_type: "LALAMOVE" | "PICKUP" | "INTERNAL";
      notes: string | null;
      customer_name?: string;
      customer_email?: string;
      created_at?: number;
      updated_at?: number;
      items?: any[];
      total?: number;
      total_quantity?: number;
      item_count?: number;
    };

    if (!data_parsed) {
      throw new Error("Invalid order data provided.");
    }

    this.publishBySubscribed(
      {
        type: "ORDER_UPDATED",
        payload: data_parsed,
      },
      TOPIC.ORDERS,
      [this.session.ws.id],
    );
  }
}
