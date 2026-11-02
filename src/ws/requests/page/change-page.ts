import z from "zod";
import { RequestBase, Request } from "../request-base";
import { canSubscribe } from "../../authorization";
import { TOPIC } from "../../topic";

@Request("CHANGE_PAGE")
export class ChangePageHandler extends RequestBase<
  typeof ChangePageHandler.schema
> {
  static override schema = z.tuple([
    z
      .string()
      .min(1, "Page name cannot be empty")
      .max(50, "Page name cannot exceed 50 characters"),
  ]);
  override skipValidation = false;

  override execute(): void | Promise<void> {
    const [new_page] = this.data;
    if (!canSubscribe(this.session.user.role, new_page)) throw new Error("Subscription not permitted.");

    if (this.session.page !== new_page) {
      this.session.ws.unsubscribe(this.session.page);
      this.session.page = new_page;
    }
    // A new session starts on dashboard before it has subscribed to any page.
    this.session.ws.subscribe(this.session.page);
    this.write(JSON.stringify({ type: "WS_SUBSCRIBED", payload: { topic: new_page } }));

    this.publish(
      {
        type: "CHANGE_PAGE",
        payload: {
          id: this.session.ws.id,
          page: new_page,
        },
      },
      TOPIC.SESSION_AND_LOGS,
    );
  }
}
