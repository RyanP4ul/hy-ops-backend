import z from "zod";
import { RequestBase, Request } from "../request-base";
import { logger } from "../../../utils/logger";
import { TOPIC } from "../../topic";

@Request("SESSION_OUT")
export class SessionOutHandler extends RequestBase<
  typeof SessionOutHandler.schema
> {
  static override schema = z.tuple([z.string()]);
  override skipValidation = false;

  override async execute(): Promise<void> {
    logger.silly(
      `Session out for user ${this.session.user.email} with socket id: ${this.session.ws.id}`,
    );

    this.publish(
      {
        type: "SESSION_OUT",
        payload: {
          user_id: this.session.user.sub,
          session_id: this.session.ws.id,
        },
      },
      TOPIC.SESSION_AND_LOGS,
    );

    // const [meta] = this.data;
    // await NotificationService.createNotification(
    //   this.session.user.id,
    //   "Product Added",
    //   "Product Desciption Test",
    //   meta,
    // );
  }
}
