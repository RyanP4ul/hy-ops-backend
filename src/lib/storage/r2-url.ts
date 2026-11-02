import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { r2, r2Bucket } from "./r2";

export async function getProductImageUrl(key: string) {
  if (!/^products\/[0-9a-f-]+\.webp$/i.test(key)) {
    throw new Error("Invalid product image key.");
  }

  return getSignedUrl(
    r2,
    new GetObjectCommand({
      Bucket: r2Bucket,
      Key: key,
    }),
    { expiresIn: 300 },
  );
}
