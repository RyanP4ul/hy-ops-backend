import z from "zod";
import { RequestBase, Request } from "../request-base";
import { NotificationService } from "../../../modules/notifications/service";

@Request("ADD_PRODUCT")
export class AddProductHandler extends RequestBase<
  typeof AddProductHandler.schema
> {
  static override schema = z.tuple([z.string()]);
  override skipValidation = false;

  override async execute(): Promise<void> {
    const [meta] = this.data;

    await NotificationService.createNotification(
      this.session.user.id,
      "Product Added",
      "Product Desciption Test",
      meta,
    );
  }
}
