import z from "zod";
import { RequestBase, Request } from "../request-base";

@Request("NEW_SESSION")
export class NewSessionHandler extends RequestBase<
  typeof NewSessionHandler.schema
> {
  static override schema = z.tuple([]);
  override skipValidation = false;

  override async execute(): Promise<void> {
    this.publish({
      type: "NEW_SESSION",
      payload: {
        id: this.session.ws.id,
        ip_address: this.session.ip_address,
        page: "unknown",
        user: this.session.user,
      },
    });
    // const [meta] = this.data;
    // await NotificationService.createNotification(
    //   this.session.user.id,
    //   "Product Added",
    //   "Product Desciption Test",
    //   meta,
    // );
  }
}
