import z from "zod";
import { RequestBase, Request } from "../request-base";
import { TOPIC } from "../../topic";
import { WarehouseInsert } from "@/db/schema/warehouses";

@Request("WAREHOUSE_UPDATED")
export class UpdateWarehouseHandler extends RequestBase<
  typeof UpdateWarehouseHandler.schema
> {
  static override schema = z.tuple([z.string()]);
  override skipValidation = false;

  override async execute(): Promise<void> {
    const [warehouse_data] = this.data;

    const data_parsed = JSON.parse(warehouse_data) as Required<
      Omit<WarehouseInsert, "created_at" | "updated_at">
    >;

    if (!data_parsed) {
      throw new Error("Invalid warehouse data provided.");
    }

    this.publishBySubscribed(
      {
        type: "WAREHOUSE_UPDATED",
        payload: data_parsed,
      },
      TOPIC.WAREHOUSES,
      [this.session.ws.id],
    );
  }
}
