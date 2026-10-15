import z from "zod";
import { RequestBase, Request } from "../request-base";
import { TOPIC } from "../../topic";

@Request("USER_ADDED")
export class AddUserHandler extends RequestBase<typeof AddUserHandler.schema> {
  static override schema = z.tuple([z.string()]);

  override async execute(): Promise<void> {
    const [userData] = this.data;
    const parsedUser = JSON.parse(userData);

    this.publishBySubscribed(
      {
        type: "USER_ADDED",
        payload: { ...parsedUser, version: 1 },
      },
      TOPIC.USERS,
      [this.session.ws.id],
    );
  }
}
