import z from "zod";
import { RequestBase, Request } from "../request-base";
import { TOPIC } from "../../topic";

@Request("USER_ARCHIVED")
export class ArchiveUserHandler extends RequestBase<
  typeof ArchiveUserHandler.schema
> {
  static override schema = z.tuple([z.number(), z.number()]);

  override async execute(): Promise<void> {
    const [, userId] = this.data;

    this.publish(
      {
        type: "USER_ARCHIVED",
        payload: { id: userId },
      },
      TOPIC.USERS,
    );
  }
}
