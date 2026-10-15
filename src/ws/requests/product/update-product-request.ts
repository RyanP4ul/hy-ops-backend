import z from "zod";
import { RequestBase, Request } from "../request-base";

@Request("PRODUCT_UPDATED")
export class UpdateProductHandler extends RequestBase<
  typeof UpdateProductHandler.schema
> {
  static override schema = z.tuple([z.string()]);
  override skipValidation = false;

  override async execute(): Promise<void> {}
}
