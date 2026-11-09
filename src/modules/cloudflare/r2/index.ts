import { Elysia, t } from "elysia";
import { uploadImage } from "./service";
import { logger } from "../../../utils/logger";

export const cloudflareR2Routes = new Elysia({
  prefix: "/cloudflare/r2",
}).post(
  "/images",
  async ({ body, set }) => {
    try {
      const result = await uploadImage(body.delivery_id, body.file);

      set.status = 201;

      return {
        success: true,
        message: "Product image uploaded successfully.",
        data: result,
      };
    } catch (error) {
      if (error instanceof Error) {
        const clientError =
          error.message.startsWith("Image ") ||
          error.message.startsWith("Only ") ||
          error.message.startsWith("Invalid ");

        if (clientError) {
          set.status = 400;
          return {
            success: false,
            message: error.message,
          };
        }
      }

      if (error instanceof Error) {
        logger.error("Product image upload failed:", error.message);
      }

      set.status = 500;

      return {
        success: false,
        message: "Failed to upload product image.",
      };
    }
  },
  {
    body: t.Object({
      delivery_id: t.Number(),
      file: t.File({
        maxSize: 5 * 1024 * 1024,
      }),
    }),
    detail: {
      summary: "Upload a product image",
      description: "Upload an image associated with a delivery.",
      tags: ["Cloudflare"],
    },
  },
);
