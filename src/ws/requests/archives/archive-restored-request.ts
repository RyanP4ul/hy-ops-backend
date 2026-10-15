import z from "zod";
import { RequestBase, Request } from "../request-base";
import { WarehouseInsert } from "@/db/schema/warehouses";
import { TOPIC } from "../../topic";
import { WarehouseService } from "../../../modules/warehouse/service";
import { ArchiveService } from "../../../modules/archives/service";

@Request("ARCHIVE_RESTORED")
export class ArchiveRestoredHandler extends RequestBase<
  typeof ArchiveRestoredHandler.schema
> {
  static override schema = z.tuple([z.number(), z.number(), z.string()]);
  override skipValidation = false;

  override async execute(): Promise<void> {
    const [archived_id, entity_id, entity_table] = this.data;

    // SINCE WE ALREADY DELETED THE ARCHIVE, THIS SHIT IS UNCESSARY
    // const archive = await ArchiveService.doesArchiveExist(archived_id);

    // if (!archive) {
    //   throw new Error(`Archive with ID ${archived_id} not found.`);
    // }

    switch (entity_table) {
      case "warehouses":
        await this.restoreWarehouse(entity_id);
        break;
      default:
        throw new Error(`Unsupported entity table: ${entity_table}`);
    }
  }

  async restoreWarehouse(entity_id: number) {
    const warehouse = await WarehouseService.getWarehouseById(entity_id);

    if (!warehouse) {
      throw new Error(`Warehouse with ID ${entity_id} not found.`);
    }

    this.publish(
      {
        type: "WAREHOUSE_RESTORED",
        payload: {
          id: warehouse.id,
          name: warehouse.name,
          street_address: warehouse.street_address,
          city: warehouse.city,
          state: warehouse.state,
          zip_code: warehouse.zip_code,
          version: warehouse.version,
          created_at: warehouse.created_at,
          updated_at: warehouse.updated_at,
        },
      },
      TOPIC.WAREHOUSES,
    );
  }
}
