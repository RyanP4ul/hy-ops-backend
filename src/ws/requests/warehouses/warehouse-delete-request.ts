import z from "zod";
import { RequestBase, Request } from "../request-base";
import { TOPIC } from "../../topic";

@Request("WAREHOUSE_DELETED")
export class DeleteWarehouseHandler extends RequestBase<
  typeof DeleteWarehouseHandler.schema
> {
  static override schema = z.tuple([z.number()]);
  override skipValidation = false;

  override async execute(): Promise<void> {
    const [warehouse_id] = this.data;

    if (!warehouse_id) {
      throw new Error("Invalid warehouse ID provided.");
    }

    this.publish(
      {
        type: "WAREHOUSE_DELETED",
        payload: {
          id: warehouse_id,
        },
      },
      TOPIC.WAREHOUSES,
    );
  }
}
