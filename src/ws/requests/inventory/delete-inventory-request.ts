import z from "zod";
import { RequestBase, Request } from "../request-base";
import { TOPIC } from "../../topic";

@Request("INVENTORY_DELETED")
export class DeleteInventoryHandler extends RequestBase<
  typeof DeleteInventoryHandler.schema
> {
  static override schema = z.tuple([z.number()]);

  override async execute(): Promise<void> {
    const [inventoryId] = this.data;

    if (!inventoryId) {
      throw new Error("Invalid inventory ID provided.");
    }

    this.publishBySubscribed(
      {
        type: "INVENTORY_DELETED",
        payload: { id: inventoryId },
      },
      TOPIC.INVENTORY,
      [this.session.ws.id],
    );
  }
}
