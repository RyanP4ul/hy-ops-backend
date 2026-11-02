import z from "zod";
import { RequestBase, Request } from "../request-base";
import { TOPIC } from "../../topic";

@Request("PRODUCT_UPDATED")
export class UpdateProductHandler extends RequestBase<
  typeof UpdateProductHandler.schema
> {
  static override schema = z.tuple([z.string()]);
  override skipValidation = false;

  override async execute(): Promise<void> {
    const [productData] = this.data;
    const product = JSON.parse(productData);

    if (!product?.id) {
      throw new Error("Invalid product data provided.");
    }

    this.publishBySubscribed(
      {
        type: "PRODUCT_UPDATED",
        payload: product,
      },
      TOPIC.PRODUCTS,
      [this.session.ws.id],
    );
  }
}
