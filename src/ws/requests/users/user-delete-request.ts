import z from "zod";
import { RequestBase, Request } from "../request-base";
import { TOPIC } from "../../topic";

@Request("USER_DELETED")
export class DeleteUserHandler extends RequestBase<
  typeof DeleteUserHandler.schema
> {
  static override schema = z.tuple([z.number()]);

  override async execute(): Promise<void> {
    const [userId] = this.data;

    this.publish(
      {
        type: "USER_DELETED",
        payload: { id: userId },
      },
      TOPIC.USERS,
    );
  }
}
