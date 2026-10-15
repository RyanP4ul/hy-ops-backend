import z from "zod";
import { RequestBase, Request } from "../request-base";
import { TOPIC } from "../../topic";
import { ArchiveService } from "../../../modules/archives/service";
import { TableName } from "@/db/table";
import { WarehouseService } from "../../../modules/warehouse/service";
import { UserService } from "../../../modules/user/service";

@Request("WAREHOUSE_ARCHIVED")
export class ArchiveWarehouseHandler extends RequestBase<
  typeof ArchiveWarehouseHandler.schema
> {
  static override schema = z.tuple([z.number(), z.number()]);
  override skipValidation = false;

  override async execute(): Promise<void> {
    const [archive_id, warehouse_id] = this.data;

    if (!warehouse_id) {
      throw new Error("Invalid warehouse ID provided.");
    }

    const archive = await ArchiveService.getArchiveById(archive_id);

    if (!archive) {
      throw new Error(`Archive with ID ${archive_id} not found.`);
    }

    const warehouse = await WarehouseService.getWarehouseById(
      warehouse_id,
      true,
    );

    if (!warehouse) {
      throw new Error(`Warehouse with ID ${warehouse_id} not found.`);
    }

    const user = await UserService.findUserById(String(archive.archived_by));

    if (!user) {
      throw new Error(`User with ID ${archive.archived_by} not found.`);
    }

    const entity_data = await ArchiveService.getEntityData(
      "warehouses" as TableName,
      warehouse_id,
    );

    this.publish(
      {
        type: "WAREHOUSE_ARCHIVED",
        payload: {
          id: warehouse_id,
        },
      },
      TOPIC.WAREHOUSES,
    );

    this.publish(
      {
        type: "ARCHIVE_CREATED",
        payload: {
          id: archive.id,
          entity_id: archive.entity_id,
          entity_type: archive.entity_type,
          archived_by: archive.archived_by,
          data: entity_data,
          user: {
            id: user.id,
            name: user.name,
          },
        },
      },
      TOPIC.ARCHIVES,
    );
  }
}
