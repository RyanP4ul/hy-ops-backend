import z from "zod";
import { RequestBase, Request } from "../request-base";
import { NotificationService } from "../../../modules/notifications/service";

@Request("CREATE_NOTIFICATION")
export class CreateNotificationHandler extends RequestBase<
  typeof CreateNotificationHandler.schema
> {
  static override schema = z.tuple([
    z.string().nonempty(),
    z.string().nonempty(),
    z.boolean().default(false),
    z.string().optional(),
  ]);
  override skipValidation = false;

  override async execute(): Promise<void> {
    const user_id = this.session.user.id;
    const [title, message, is_global, metadata] = this.data;

    await NotificationService.createNotification(
      user_id,
      title,
      message,
      metadata,
    );
  }
}
