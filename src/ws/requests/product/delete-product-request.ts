import z from "zod";
import { RequestBase, Request } from "../request-base";
import { TOPIC } from "../../topic";

@Request("PRODUCT_DELETED")
export class DeleteProductHandler extends RequestBase<
  typeof DeleteProductHandler.schema
> {
  static override schema = z.tuple([z.number()]);
  override skipValidation = false;

  override async execute(): Promise<void> {
    const [productId] = this.data;

    if (!productId) {
      throw new Error("Invalid product ID provided.");
    }

    this.publishBySubscribed(
      {
        type: "PRODUCT_DELETED",
        payload: {
          id: productId,
        },
      },
      TOPIC.PRODUCTS,
      [this.session.ws.id],
    );
  }
}
