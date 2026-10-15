import z from "zod";
import { RequestBase, Request } from "../request-base";
import { TOPIC } from "../../topic";

@Request("USER_UPDATED")
export class UpdateUserHandler extends RequestBase<
  typeof UpdateUserHandler.schema
> {
  static override schema = z.tuple([z.string()]);

  override async execute(): Promise<void> {
    if (!this.data) return;

    const [userData] = this.data;
    const parsedUser = JSON.parse(userData);

    if (!parsedUser?.id) {
      throw new Error("Invalid user data provided.");
    }

    this.publishBySubscribed(
      {
        type: "USER_UPDATED",
        payload: parsedUser,
      },
      TOPIC.USERS,
      [this.session.ws.id],
    );
  }
}
