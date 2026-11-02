import z from "zod";
import { RequestBase, Request } from "../request-base";
import { TOPIC } from "../../topic";

@Request("INVENTORY_UPDATED")
export class UpdateInventoryHandler extends RequestBase<
  typeof UpdateInventoryHandler.schema
> {
  static override schema = z.tuple([z.string()]);

  override async execute(): Promise<void> {
    const [inventoryData] = this.data;
    const inventory = JSON.parse(inventoryData);

    if (!inventory?.id) {
      throw new Error("Invalid inventory data provided.");
    }

    this.publishBySubscribed(
      { type: "INVENTORY_UPDATED", payload: inventory },
      TOPIC.INVENTORY,
      [this.session.ws.id],
    );
  }
}
