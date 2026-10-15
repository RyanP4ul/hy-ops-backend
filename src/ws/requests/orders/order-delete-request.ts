import z from "zod";
import { RequestBase, Request } from "../request-base";
import { TOPIC } from "../../topic";

@Request("ORDER_DELETED")
export class DeleteOrderHandler extends RequestBase<typeof DeleteOrderHandler.schema> {
  static override schema = z.tuple([z.number()]);
  override skipValidation = false;

  override async execute(): Promise<void> {
    const [order_id] = this.data;

    if (!order_id) {
      throw new Error("Invalid order ID provided.");
    }

    this.publish(
      {
        type: "ORDER_DELETED",
        payload: {
          id: order_id,
        },
      },
      TOPIC.ORDERS,
    );
  }
}
