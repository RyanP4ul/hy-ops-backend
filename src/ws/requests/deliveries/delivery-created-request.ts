import z from "zod";
import { RequestBase, Request } from "../request-base";
import { TOPIC } from "../../topic";

@Request("DELIVERY_CREATED")
export class DeliveryCreatedHandler extends RequestBase<
  typeof DeliveryCreatedHandler.schema
> {
  static override schema = z.tuple([z.string()]);

  override async execute(): Promise<void> {
    const [data] = this.data;
    const delivery = JSON.parse(data);

    if (!delivery?.delivery_id) {
      throw new Error("Invalid delivery data provided.");
    }

    this.publishBySubscribed(
      { type: "DELIVERY_CREATED", payload: delivery },
      TOPIC.DELIVERIES,
      [this.session.ws.id],
    );
  }
}
