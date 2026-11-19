import z from "zod";
import { RequestBase, Request } from "../request-base";
import { logger } from "../../../utils/logger";
import { socketManager } from "../../socket-manager";
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

    socketManager.broadcastToTopic(
      TOPIC.SESSION_AND_LOGS,
      {
        type: "SESSION_OUT",
        payload: {
          user_id: this.session.user.sub,
          session_id: this.session.ws.id,
        },
      },
      { excludeSocketId: this.session.ws.id, allowedRoles: ["admin"] },
    );
  }
}
