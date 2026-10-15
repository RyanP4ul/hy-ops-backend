import z from "zod";
import { RequestBase, Request } from "../request-base";
import { WarehouseInsert } from "@/db/schema/warehouses";
import { TOPIC } from "../../topic";

@Request("WAREHOUSE_ADDED")
export class AddWarehouseHandler extends RequestBase<
  typeof AddWarehouseHandler.schema
> {
  static override schema = z.tuple([z.string()]);
  override skipValidation = false;

  override async execute(): Promise<void> {
    const [warehouse_data] = this.data;

    const data_parsed = JSON.parse(warehouse_data) as Required<
      Omit<WarehouseInsert, "version" | "created_at" | "updated_at">
    >;

    if (!data_parsed) {
      throw new Error("Invalid warehouse data provided.");
    }

    this.publishBySubscribed(
      {
        type: "WAREHOUSE_ADDED",
        payload: {
          ...data_parsed,
          version: 1,
        },
      },
      TOPIC.WAREHOUSES,
      [this.session.ws.id],
    );
  }
}
